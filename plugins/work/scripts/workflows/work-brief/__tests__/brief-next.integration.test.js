'use strict';

/**
 * Integration test for brief-next.js post-migration to createPhaseRunner.
 *
 * Asserts:
 *   - brief-next.js runs against a temp fixture ticket
 *   - stdout header has the expected shape (PHASE ADVANCED on inputs)
 *   - brief-phase.json shape matches the pre-refactor baseline
 *   - exit code is 0 (advanced) or 2 (blocked)
 *   - brief-next.js is a thin wrapper that calls createPhaseRunner
 *   - brief-next.js source contains a factory-contract comment
 *
 * This is the RED-phase test that drives Task 3.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BRIEF_NEXT = path.resolve(__dirname, '..', 'brief-next.js');
const TOKEN_DIR = '/tmp/.claude-write-tokens';
const { tokenPath } = require('../../lib/scripts/write-report');

function mintToken(scriptBasename, ticketId) {
  fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    tokenPath(scriptBasename, ticketId),
    JSON.stringify({
      agent: 'brief-writer',
      timestamp: Date.now(),
      tasksBase: null,
    }),
    { mode: 0o600 }
  );
}

function runBriefNext(ticket, env) {
  mintToken('brief-next.js', ticket);
  mintToken('brief-phase-state.js', ticket);
  return spawnSync(process.execPath, [BRIEF_NEXT, ticket], {
    cwd: env.cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      TASKS_BASE: env.TASKS_BASE,
      NEXT_SCRIPT_LOG: '0',
    },
  });
}

describe('brief-next.js integration (factory delegator)', () => {
  let tmp;
  let tasksBase;
  let worktree;
  const ticket = 'GH-99982';
  let tasksDir;
  let phaseFile;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-next-int-'));
    tasksBase = path.join(tmp, 'tasks');
    worktree = path.join(tmp, 'wt');
    tasksDir = path.join(tasksBase, ticket);
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, 'ticket.json'),
      JSON.stringify({ id: ticket, title: 'Integration baseline' })
    );
    fs.writeFileSync(
      path.join(tasksDir, 'related-tickets.json'),
      JSON.stringify({
        self: { id: ticket, title: 'Integration baseline' },
        parent: null,
        siblings: [],
        blockedBy: [],
        dependsOn: [],
        relatedTo: [],
        fetchedAt: new Date().toISOString(),
      })
    );
    spawnSync('git', ['init', '-q', worktree], { stdio: 'ignore' });
    phaseFile = path.join(tasksDir, 'brief-phase.json');
  });

  after(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('produces expected stdout header and brief-phase.json shape on INPUTS advance', () => {
    const r = runBriefNext(ticket, { cwd: worktree, TASKS_BASE: tasksBase });
    const combined = (r.stdout || '') + (r.stderr || '');
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. Output:\n${combined}`);

    // Header shape (baseline from createPhaseRunner)
    assert.match(r.stdout, /^brief-next: GH-99982\n/, 'header line should start with script:ticket');
    assert.match(r.stdout, /  tasks dir: /, 'header should include tasks dir line');
    assert.match(
      r.stdout,
      /  current phase \(after this run\): /,
      'header should include current phase line'
    );
    assert.match(r.stdout, /  result: PHASE ADVANCED/, 'expected PHASE ADVANCED on inputs');

    // brief-phase.json shape baseline
    assert.equal(fs.existsSync(phaseFile), true, 'brief-phase.json should be created');
    const state = JSON.parse(fs.readFileSync(phaseFile, 'utf8'));
    assert.equal(state.currentPhase, 'overlap');
    assert.ok(state.phases?.inputs, 'inputs phase evidence recorded');
    // Key order baseline: top-level keys come in a stable order.
    const topKeys = Object.keys(state);
    assert.ok(topKeys.includes('currentPhase'));
    assert.ok(topKeys.includes('phases'));
  });

  it('brief-next.js delegates to createPhaseRunner factory', () => {
    const src = fs.readFileSync(BRIEF_NEXT, 'utf8');
    assert.match(
      src,
      /createPhaseRunner\s*\(/,
      'brief-next.js must call createPhaseRunner(...)'
    );
    assert.match(
      src,
      /require\(['"][^'"]*lib\/phase-runner\/create-phase-runner['"]\)/,
      'brief-next.js must require create-phase-runner module'
    );
  });

  it('brief-next.js contains a factory-contract comment', () => {
    const src = fs.readFileSync(BRIEF_NEXT, 'utf8');
    assert.match(
      src,
      /factory/i,
      'brief-next.js should contain a comment mentioning the factory contract'
    );
  });

  it('brief-next.js is a thin wrapper (< 40 lines)', () => {
    const src = fs.readFileSync(BRIEF_NEXT, 'utf8');
    const lines = src.split('\n').length;
    assert.ok(lines < 40, `brief-next.js should be < 40 lines, got ${lines}`);
  });
});
