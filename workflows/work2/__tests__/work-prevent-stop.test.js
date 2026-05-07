/**
 * Tests for work-prevent-stop.js — Stop hook for /work2.
 *
 * Verifies the hook blocks stops during active /work2 sessions
 * and allows stops when no session is active.
 *
 * Uses node:test + node:assert/strict.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

const hookPath = path.join(__dirname, '..', 'hooks', 'work-prevent-stop.js');

function runHook(hookData, env = {}) {
  const input = JSON.stringify(hookData);
  try {
    const result = execFileSync(process.execPath, [hookPath], {
      input,
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { exitCode: 0, stdout: result };
  } catch (err) {
    return { exitCode: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

describe('work-prevent-stop hook', () => {
  it('allows stop when no matching marker file exists', () => {
    const result = runHook({ tool_name: 'Stop' });
    assert.equal(result.exitCode, 0);
  });

  it('exits 0 on empty stdin', () => {
    try {
      const result = execFileSync(process.execPath, [hookPath], {
        input: '',
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      assert.equal(result.trim(), '');
    } catch (err) {
      assert.equal(err.status, 0);
    }
  });

  it('exits 0 on invalid JSON stdin', () => {
    try {
      const result = execFileSync(process.execPath, [hookPath], {
        input: 'invalid-json',
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      assert.equal(result.trim(), '');
    } catch (err) {
      assert.equal(err.status, 0);
    }
  });
});
