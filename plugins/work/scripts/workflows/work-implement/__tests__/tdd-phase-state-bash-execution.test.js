'use strict';

/**
 * Regression test for GH-392 review-comment-2 (cursor[bot]):
 *
 * `tdd-phase-state.js`'s `runTestCommandWithOutput` previously used
 * `spawnSync(cmd, { shell: true })`, which Node executes via `/bin/sh`.
 * On Debian/Ubuntu, `/bin/sh` is `dash` — a POSIX shell that does NOT
 * support `set -o pipefail`. Callers (task-next.js recordEvidence)
 * forward strict-mode-wrapped commands (`set -euo pipefail; ...`) per
 * GH-392 §P0#3. Under dash, the recorder would fail with
 *   `set: Illegal option -o pipefail`
 * even though the test command itself would have succeeded.
 *
 * The fix switches to `spawnSync('bash', ['-lc', cmd])` so strict-mode
 * wrappers execute under bash, matching task-next.js's own runTest()
 * invocation.
 *
 * This regression test asserts the source of tdd-phase-state.js calls
 * `spawnSync('bash', ['-lc', cmd], ...)` for its test-command runner,
 * rather than the previous `spawnSync(cmd, { shell: true, ... })` form.
 * A behavioral end-to-end test would require driving the full
 * record-red CLI path with git-tracked test files and a valid token,
 * which is exercised by auto-init-record.test.js. This narrower test
 * locks the specific source pattern that GUARANTEES strict-mode
 * wrappers (set -euo pipefail; ...) execute under bash rather than
 * dash.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TDD_PHASE_STATE_PATH = path.resolve(__dirname, '..', 'tdd-phase-state.js');

describe('tdd-phase-state.js test-command execution path (review-comment-2)', () => {
  it('runTestCommandWithOutput invokes the cmd via bash -lc, not via shell: true', () => {
    const src = fs.readFileSync(TDD_PHASE_STATE_PATH, 'utf8');

    // Locate the runTestCommandWithOutput function body so the assertions
    // are scoped to that function rather than the whole file.
    const fnIdx = src.indexOf('function runTestCommandWithOutput');
    assert.notEqual(
      fnIdx,
      -1,
      'expected tdd-phase-state.js to define function runTestCommandWithOutput'
    );

    // Crude but sufficient: take the next ~600 chars after the fn keyword
    // and assert the spawnSync call within uses bash and NOT shell: true.
    const rawBody = src.slice(fnIdx, fnIdx + 2500);
    // Strip line comments and block comments so explanatory comments
    // referencing the old pattern don't fool the assertion.
    const body = rawBody
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
      .join('\n');

    assert.ok(
      /spawnSync\(\s*['"]bash['"]\s*,\s*\[\s*['"]-lc['"]\s*,\s*cmd\s*\]/m.test(body),
      'runTestCommandWithOutput must execute via spawnSync("bash", ["-lc", cmd], ...) so that ' +
        'task-next.js strict-mode-wrapped commands (set -euo pipefail; ...) work. ' +
        'spawnSync(cmd, { shell: true }) routes through /bin/sh (dash on Debian/Ubuntu) ' +
        'which does NOT support `set -o pipefail`.\n\nActual function body slice:\n' +
        body
    );

    assert.ok(
      !/shell:\s*true/.test(body),
      'runTestCommandWithOutput must NOT use { shell: true } — it routes through ' +
        '/bin/sh and breaks strict-mode wrappers forwarded by callers.\n\n' +
        'Actual function body slice:\n' +
        body
    );
  });

  it('a strict-mode-wrapped chained command executes successfully under bash', () => {
    // Behavioral sanity check: confirm that the bash invocation pattern
    // used by the fix correctly handles a `set -euo pipefail; ...` chain.
    // Under dash this same invocation would fail with "Illegal option".
    const wrapped = 'set -euo pipefail; true && echo ok';
    const result = spawnSync('bash', ['-lc', wrapped], { encoding: 'utf8' });
    assert.equal(
      result.status,
      0,
      `bash -lc must successfully run strict-mode chain; got status=${result.status} ` +
        `stderr=${result.stderr}`
    );
    assert.match(result.stdout, /ok/);
  });

  it('confirms /bin/sh on this platform would have broken the prior implementation when it is dash', () => {
    // Documentary check: skip cleanly on bash-as-sh platforms (e.g. some
    // macOS setups) so the test suite stays green there. On dash-as-sh
    // (Debian/Ubuntu CI), the prior `{ shell: true }` would have errored
    // on `set -o pipefail`. This makes the threat model explicit in test
    // form.
    const shVersion = spawnSync('/bin/sh', ['-c', 'set -o pipefail; echo ok'], {
      encoding: 'utf8',
    });
    if (shVersion.status === 0) {
      // bash-as-sh platform — fix is still correct, just not provably
      // necessary here. Document and pass.
      return;
    }
    assert.notEqual(
      shVersion.status,
      0,
      'expected /bin/sh (dash) to reject `set -o pipefail` — this is the bug ' +
        'the fix prevents from reaching the recorder.'
    );
    assert.match(
      (shVersion.stderr || '') + (shVersion.stdout || ''),
      /pipefail|Illegal option|bad option/i,
      `expected /bin/sh to complain about pipefail option; stderr=${shVersion.stderr}`
    );
  });
});
