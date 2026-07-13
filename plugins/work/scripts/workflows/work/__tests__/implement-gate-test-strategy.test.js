/**
 * GH-610 Task 1 — `resolveTaskTestExecution` helper + `readTaskTestCommand`
 * synthesis fallback + worktreeDir threading in implement-gate.
 *
 * RED: these assert the new helper/fallback/threading that do not yet exist.
 *
 * Scenarios covered here:
 *   - Synthesizable Test-Strategy task gets a runnable command at implement
 *   - Legacy Test-Command task is unchanged with the flag off
 *   - Strategy present but synthesis returns null for a non-citation kind
 *
 * (The "flows through the implement gate end-to-end" scenario lives in the
 * sibling .integration.test.js.)
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const implementGate = require('../lib/step-enrichments/implement-gate');

// ── helpers ────────────────────────────────────────────────────────────────

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gh610-task1-'));
}

function writeTasksMd(tasksDir, body) {
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, 'tasks.md'), body);
}

function writeEnvrc(worktreeDir, contents) {
  fs.mkdirSync(worktreeDir, { recursive: true });
  fs.writeFileSync(path.join(worktreeDir, '.envrc'), contents);
}

const ORIGINAL_FLAG = process.env.WORK_TEST_STRATEGY_VALIDATOR;
function setFlag(value) {
  if (value === undefined) delete process.env.WORK_TEST_STRATEGY_VALIDATOR;
  else process.env.WORK_TEST_STRATEGY_VALIDATOR = value;
}

let tmp;
beforeEach(() => {
  tmp = mkTmp();
});
afterEach(() => {
  setFlag(ORIGINAL_FLAG);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ── scenario: Synthesizable Test-Strategy task gets a runnable command ───────

describe('readTaskTestCommand synthesis fallback (flag ON, no ### Test Command)', () => {
  it('synthesizes a unit envelope command from ### Test Strategy', () => {
    setFlag('1');
    const tasksDir = path.join(tmp, 'GH-TEST');
    const worktreeDir = path.join(tmp, 'wt');
    writeEnvrc(worktreeDir, 'export TEST_UNIT_COMMAND="pnpm vitest run $CHANGED_FILES"\n');
    writeTasksMd(
      tasksDir,
      [
        '## Task 1 — Synthesizable unit task',
        '',
        '### Type',
        'backend',
        '',
        '### Files in scope',
        '- src/foo.js',
        '',
        '### Test Strategy',
        '```',
        'kind: unit',
        'entry: src/foo.test.js',
        '```',
        '',
      ].join('\n')
    );

    const cmd = implementGate.readTaskTestCommand(tasksDir, 1, worktreeDir);
    assert.ok(cmd, 'expected a synthesized command, got null');
    assert.match(cmd, /CHANGED_FILES="src\/foo\.test\.js"/);
    assert.match(cmd, /TEST_UNIT_COMMAND/);
  });

  it('resolveTaskTestExecution reports source:strategy and the strategyKind', () => {
    setFlag('1');
    const tasksDir = path.join(tmp, 'GH-TEST');
    const worktreeDir = path.join(tmp, 'wt');
    writeEnvrc(worktreeDir, 'export TEST_UNIT_COMMAND="pnpm vitest run $CHANGED_FILES"\n');
    writeTasksMd(
      tasksDir,
      [
        '## Task 1 — Synthesizable unit task',
        '',
        '### Type',
        'backend',
        '',
        '### Files in scope',
        '- src/foo.js',
        '',
        '### Test Strategy',
        '```',
        'kind: unit',
        'entry: src/foo.test.js',
        '```',
        '',
      ].join('\n')
    );

    const res = implementGate.resolveTaskTestExecution(tasksDir, 1, worktreeDir);
    assert.equal(res.source, 'strategy');
    assert.equal(res.strategyKind, 'unit');
    assert.ok(res.command, 'expected a synthesized command');
    assert.match(res.command, /TEST_UNIT_COMMAND/);
    assert.equal(res.citation, null);
  });
});

// ── scenario: citation kind → command null, citation populated ───────────────

describe('resolveTaskTestExecution citation kind (verified-by)', () => {
  it('returns command:null with a populated citation and source:strategy', () => {
    setFlag('1');
    const tasksDir = path.join(tmp, 'GH-TEST');
    const worktreeDir = path.join(tmp, 'wt');
    writeEnvrc(worktreeDir, 'export TEST_UNIT_COMMAND="pnpm vitest run $CHANGED_FILES"\n');
    writeTasksMd(
      tasksDir,
      [
        '## Task 1 — Peer task',
        '',
        '### Type',
        'backend',
        '',
        '### Files in scope',
        '- src/foo.js',
        '',
        '### Test Strategy',
        '```',
        'kind: unit',
        'entry: src/foo.test.js',
        '```',
        '',
        '---',
        '',
        '## Task 2 — Citing task',
        '',
        '### Type',
        'backend',
        '',
        '### Files in scope',
        '- src/foo.js',
        '',
        '### Test Strategy',
        '```',
        'kind: verified-by',
        'peer: Task 1',
        '```',
        '',
      ].join('\n')
    );

    const res = implementGate.resolveTaskTestExecution(tasksDir, 2, worktreeDir);
    assert.equal(res.source, 'strategy');
    assert.equal(res.strategyKind, 'verified-by');
    assert.equal(res.command, null, 'citation kinds have no runnable command');
    assert.ok(res.citation, 'expected a populated citation object');
    assert.equal(res.citation.kind, 'verified-by');
    assert.equal(res.citation.peer, 'Task 1');
  });
});

// ── scenario: Strategy present but synthesis returns null for a non-citation kind

describe('resolveTaskTestExecution non-citation kind with null synthesis', () => {
  it('produces a distinct "synthesis returned null for a non-citation kind" error', () => {
    setFlag('1');
    const tasksDir = path.join(tmp, 'GH-TEST');
    const worktreeDir = path.join(tmp, 'wt');
    writeEnvrc(worktreeDir, '');
    // custom kind with NEITHER command NOR a fenced bash body → synthesize null
    writeTasksMd(
      tasksDir,
      [
        '## Task 1 — Custom strategy with no body',
        '',
        '### Type',
        'backend',
        '',
        '### Files in scope',
        '- src/foo.js',
        '',
        '### Test Strategy',
        '```',
        'kind: custom',
        '```',
        '',
      ].join('\n')
    );

    assert.throws(
      () => implementGate.resolveTaskTestExecution(tasksDir, 1, worktreeDir),
      (err) => {
        assert.match(
          err.message,
          /synthesis returned null for a non-citation kind/i,
          'error must distinguish null-synthesis from "no strategy"'
        );
        assert.doesNotMatch(err.message, /no strategy/i);
        return true;
      }
    );
  });
});

// ── scenario: stray legacy ### Test Command block is ignored (GH-653) ───────

describe('stray legacy ### Test Command block', () => {
  it('is ignored — resolution comes from ### Test Strategy only', () => {
    const tasksDir = path.join(tmp, 'GH-TEST');
    const worktreeDir = path.join(tmp, 'wt');
    writeEnvrc(worktreeDir, 'export TEST_UNIT_COMMAND="pnpm vitest run $CHANGED_FILES"\n');
    writeTasksMd(
      tasksDir,
      [
        '## Task 1 — Task with a stray legacy block',
        '',
        '### Type',
        'backend',
        '',
        '### Test Command',
        '```bash',
        'pnpm test legacy.spec.js',
        '```',
        '',
        '### Test Strategy',
        '```',
        'kind: unit',
        'entry: src/foo.test.js',
        '```',
        '',
      ].join('\n')
    );

    const cmd = implementGate.readTaskTestCommand(tasksDir, 1, worktreeDir);
    assert.equal(cmd, 'CHANGED_FILES="src/foo.test.js" eval "$TEST_UNIT_COMMAND"');

    const res = implementGate.resolveTaskTestExecution(tasksDir, 1, worktreeDir);
    assert.equal(res.source, 'strategy');
    assert.equal(res.command, 'CHANGED_FILES="src/foo.test.js" eval "$TEST_UNIT_COMMAND"');
  });

  it('readTaskTestCommand without a worktreeDir resolves to null (no envelope root)', () => {
    const tasksDir = path.join(tmp, 'GH-TEST');
    writeTasksMd(
      tasksDir,
      [
        '## Task 1 — Strategy-only task',
        '',
        '### Type',
        'backend',
        '',
        '### Test Strategy',
        '```',
        'kind: unit',
        'entry: src/foo.test.js',
        '```',
        '',
      ].join('\n')
    );

    assert.equal(implementGate.readTaskTestCommand(tasksDir, 1), null);
  });
});
