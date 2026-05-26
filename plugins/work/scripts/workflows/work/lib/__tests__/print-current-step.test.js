'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ALL_STEPS } = require('../../step-registry');

const SCRIPT = path.join(__dirname, '..', 'print-current-step.js');

function runWithTasksBase(tasksBase) {
  return spawnSync('node', [SCRIPT], {
    env: { ...process.env, TASKS_BASE: tasksBase },
    encoding: 'utf8',
  });
}

function writeStateFile(dir, ticketId, payload) {
  const ticketDir = path.join(dir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const statePath = path.join(ticketDir, '.work-state.json');
  fs.writeFileSync(statePath, payload);
  return statePath;
}

test('print-current-step: empty TASKS_BASE → exit 0, stdout empty', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcs-empty-'));
  try {
    const res = runWithTasksBase(tmp);
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    assert.equal(res.stdout, '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('print-current-step: single state file → prints mapped step name', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcs-single-'));
  try {
    const implementIndex = ALL_STEPS.indexOf('implement');
    assert.ok(implementIndex >= 0, 'step registry must contain `implement`');
    writeStateFile(tmp, 'TKT-1', JSON.stringify({
      ticketId: 'TKT-1',
      currentStep: implementIndex + 1, // 1-indexed
      status: 'in_progress',
    }));

    const res = runWithTasksBase(tmp);
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    assert.equal(res.stdout, 'implement');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('print-current-step: newest mtime wins across multiple state files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcs-multi-'));
  try {
    const ciIndex = ALL_STEPS.indexOf('ci');
    const briefIndex = ALL_STEPS.indexOf('brief');
    assert.ok(ciIndex >= 0 && briefIndex >= 0);

    const olderPath = writeStateFile(tmp, 'OLD-1', JSON.stringify({
      currentStep: briefIndex + 1,
    }));
    const newerPath = writeStateFile(tmp, 'NEW-1', JSON.stringify({
      currentStep: ciIndex + 1,
    }));

    // Force mtimes so the test is independent of write order timing.
    const past = new Date(Date.now() - 60_000);
    const now = new Date();
    fs.utimesSync(olderPath, past, past);
    fs.utimesSync(newerPath, now, now);

    const res = runWithTasksBase(tmp);
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    assert.equal(res.stdout, 'ci');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('print-current-step: malformed JSON → exit 0, stdout empty (fail-silent)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcs-bad-'));
  try {
    writeStateFile(tmp, 'BAD-1', '{ this is not json');

    const res = runWithTasksBase(tmp);
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    assert.equal(res.stdout, '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('print-current-step: missing currentStep → exit 0, stdout empty (fail-silent, no fallback to step 1)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcs-missing-step-'));
  try {
    writeStateFile(tmp, 'TKT-NO-STEP', JSON.stringify({
      ticketId: 'TKT-NO-STEP',
      status: 'in_progress',
      // currentStep intentionally omitted
    }));

    const res = runWithTasksBase(tmp);
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    assert.equal(res.stdout, '', 'must not fall back to ALL_STEPS[0]');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('print-current-step: currentStep=0 → exit 0, stdout empty (fail-silent)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcs-zero-step-'));
  try {
    writeStateFile(tmp, 'TKT-ZERO', JSON.stringify({ currentStep: 0 }));

    const res = runWithTasksBase(tmp);
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    assert.equal(res.stdout, '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('print-current-step: currentStep=null → exit 0, stdout empty (fail-silent)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcs-null-step-'));
  try {
    writeStateFile(tmp, 'TKT-NULL', JSON.stringify({ currentStep: null }));

    const res = runWithTasksBase(tmp);
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    assert.equal(res.stdout, '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('print-current-step: TASKS_BASE does not exist → exit 0, stdout empty', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcs-missing-'));
  const missing = path.join(tmp, 'does-not-exist');
  try {
    const res = runWithTasksBase(missing);
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    assert.equal(res.stdout, '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
