/**
 * Tests for the shared CLI entry runner (GH-317 / R10).
 *
 * Scenarios covered:
 *   - runs main with process.argv.slice(2) and exits with its return code
 *   - exits 1 when main throws (never surfaces a stack trace)
 *
 * Run with:
 *   node --test scripts/stats/lib/__tests__/cli-runner.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { runMain } = require('../cli-runner');

/** Run `runMain(main)` with a stubbed process.exit + argv, capturing the code. */
function captureExit(main, argv) {
  const origExit = process.exit;
  const origArgv = process.argv;
  let exitCode;
  let received;
  process.exit = (code) => {
    exitCode = code;
    throw new Error('__exit__'); // halt like the real exit would
  };
  process.argv = ['node', 'script.js', ...argv];
  try {
    runMain((parsed) => {
      received = parsed;
      return main(parsed);
    });
  } catch (err) {
    if (err.message !== '__exit__') throw err;
  } finally {
    process.exit = origExit;
    process.argv = origArgv;
  }
  return { exitCode, received };
}

describe('cli-runner — runMain (R10)', () => {
  it('exports runMain as a named function', () => {
    assert.equal(typeof runMain, 'function');
  });

  it("passes process.argv.slice(2) to main and exits with main's code", () => {
    const { exitCode, received } = captureExit(() => 0, ['all', '--json']);
    assert.equal(exitCode, 0);
    assert.deepEqual(received, ['all', '--json']);
  });

  it('exits with whatever non-zero code main returns', () => {
    const { exitCode } = captureExit(() => 1, []);
    assert.equal(exitCode, 1);
  });

  it('exits 1 when main throws', () => {
    const { exitCode } = captureExit(() => {
      throw new Error('boom');
    }, []);
    assert.equal(exitCode, 1);
  });
});
