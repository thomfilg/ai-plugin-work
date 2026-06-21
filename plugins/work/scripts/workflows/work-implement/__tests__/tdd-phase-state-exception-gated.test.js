'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.resolve(__dirname, '..', 'tdd-phase-state.js');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gh528-exc-'));
}

function runWithEnv(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('GH-528: `exception` is blocked when WORK_OPERATOR_TOKEN is unset and WORK_TDD_TOKEN_SKIP is unset', () => {
  const tmp = mkTmp();
  try {
    const env = {
      HOME: tmp,
      TASKS_BASE: path.join(tmp, 'tasks'),
      // Bypass the agent-token gate so we get past line ~1020 and into
      // cmdException; but leave WORK_OPERATOR_TOKEN unset so the new
      // operator-only gate inside cmdException fires.
      WORK_TDD_TOKEN_SKIP: '1',
      WORK_OPERATOR_TOKEN: '',
    };
    const r = runWithEnv(
      ['exception', 'TEST-1', '--category', 'config-only', '--reason', 'x'],
      env
    );
    assert.notStrictEqual(r.status, 0, 'exception should be blocked without operator token');
    const combined = (r.stdout || '') + (r.stderr || '');
    assert.match(
      combined,
      /operator-only|WORK_OPERATOR_TOKEN|Type taxonomy/i,
      'error should mention operator gate'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('GH-528: `exception` allowed when WORK_OPERATOR_TOKEN=1 (escape hatch)', () => {
  const tmp = mkTmp();
  try {
    // First init a workspace so the workspace-marker check passes
    const env = {
      HOME: tmp,
      TASKS_BASE: path.join(tmp, 'tasks'),
      WORK_TDD_TOKEN_SKIP: '1', // skip token gating in this test
      WORK_OPERATOR_TOKEN: '1', // open the operator escape hatch
    };
    // Need a workspace marker to satisfy requireTicketWorkspace
    const ticketDir = path.join(tmp, 'tasks', 'TEST-EX');
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, 'ticket.json'), '{}');

    const r = runWithEnv(
      ['exception', 'TEST-EX', '--category', 'config-only', '--reason', 'op rescue'],
      env
    );
    // Either exits 0 (happy) OR fails for unrelated reasons (e.g. new-export
    // check that needs git). We just need to confirm it got PAST the
    // operator-token gate. The gate's error message would mention
    // "WORK_OPERATOR_TOKEN"; if we don't see that, we passed it.
    const combined = (r.stdout || '') + (r.stderr || '');
    assert.doesNotMatch(
      combined,
      /WORK_OPERATOR_TOKEN/,
      'with WORK_OPERATOR_TOKEN=1, the gate must not fire'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
