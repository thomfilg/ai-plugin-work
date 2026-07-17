'use strict';

/**
 * GH-756: in WORK_TDD_MODE=outcome the phase-scoped edit hooks stand aside —
 * agents develop freely and the outcome verifier judges commits at the task
 * boundary. Both enforcement hooks must exit 0 immediately in outcome mode
 * (the GH-722 "no legal phase to author the test" deadlock class cannot
 * exist when no phase edit-lock exists).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');

const ENFORCE_HOOK = path.join(__dirname, '..', 'hooks', 'work-implement-enforce.js');
const STOP_HOOK = path.join(__dirname, '..', 'hooks', 'enforce-tdd-on-stop.js');

function runHook(hookPath, stdinObj, extraEnv = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [hookPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d;
    });
    proc.stderr.on('data', (d) => {
      stderr += d;
    });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.stdin.end(stdinObj ? JSON.stringify(stdinObj) : '');
  });
}

const EDIT_PAYLOAD = {
  tool_name: 'Edit',
  tool_input: { file_path: '/tmp/some/source-file.js' },
  session_id: 'test',
};

describe('outcome mode disables phase-scoped enforcement (GH-756)', () => {
  it('work-implement-enforce exits 0 immediately in outcome mode', async () => {
    const r = await runHook(ENFORCE_HOOK, EDIT_PAYLOAD, { WORK_TDD_MODE: 'outcome' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, '', 'no block message in outcome mode');
  });

  it('enforce-tdd-on-stop exits 0 immediately in outcome mode', async () => {
    const r = await runHook(STOP_HOOK, { session_id: 'test' }, { WORK_TDD_MODE: 'outcome' });
    assert.equal(r.code, 0, r.stderr);
  });

  it('process mode (default) still runs the hook body', async () => {
    // Without a ticket/workflow context the hook allows — but it must have
    // READ stdin (i.e. not taken the outcome-mode early exit). We can only
    // assert exit 0 here; behavioral blocking is covered by the existing
    // work-implement-enforce suites.
    const r = await runHook(ENFORCE_HOOK, EDIT_PAYLOAD, { WORK_TDD_MODE: 'process' });
    assert.equal(r.code, 0, r.stderr);
  });
});
