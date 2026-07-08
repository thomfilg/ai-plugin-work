/**
 * Tests for check/lib/typecheck-baseline.js (GH-394, echo-5137-issue-4):
 * stable error-key parsing (line numbers excluded), per-ticket baseline
 * capture/refresh, net-new detection, and the safe-env-command gating of
 * SCRIPT_TYPECHECK_COMMAND.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  TYPECHECK_BASELINE_FILE,
  parseTypecheckErrors,
  readTypecheckBaseline,
  writeTypecheckBaseline,
  resolveTypecheckCommand,
  splitTypecheckKeys,
  assessTypecheck,
  typecheckSection,
  typecheckFailureReason,
} = require('../lib/typecheck-baseline');

const ENV_KEYS = ['SCRIPT_TYPECHECK_COMMAND', 'CHECK_TYPECHECK_BASELINE'];

let dir;
let savedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'typecheck-baseline-test-'));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// Fake hardened runner (same shape as steps/run-tests.runCommand).
function fakeRun(output, exitCode) {
  return () => ({ output, exitCode });
}

describe('parseTypecheckErrors — stable keys', () => {
  it('parses classic tsc format and EXCLUDES line/column from the key', () => {
    const keys = parseTypecheckErrors(
      "src/a.ts(12,5): error TS2345: Argument of type 'string' is not assignable\n",
      2
    );
    assert.deepEqual(keys, ["src/a.ts [TS2345] Argument of type 'string' is not assignable"]);
  });

  it('parses --pretty format (file:line:col - error) identically', () => {
    const classic = parseTypecheckErrors('src/a.ts(12,5): error TS2345: Bad arg', 2);
    const pretty = parseTypecheckErrors('src/a.ts:12:5 - error TS2345: Bad arg', 2);
    assert.deepEqual(classic, pretty);
  });

  it('same error at a different line yields the SAME key (line-drift immunity)', () => {
    const before = parseTypecheckErrors('src/a.ts(12,5): error TS2345: Bad arg', 2);
    const after = parseTypecheckErrors('src/a.ts(47,9): error TS2345: Bad arg', 2);
    assert.deepEqual(before, after);
  });

  it('dedupes, sorts, ignores non-error lines, truncates long messages', () => {
    const long = 'x'.repeat(300);
    const keys = parseTypecheckErrors(
      [
        'Found 3 errors.',
        'src/b.ts(1,1): error TS1005: comma expected',
        'src/b.ts(9,1): error TS1005: comma expected',
        `src/a.ts(2,2): error TS2322: ${long}`,
      ].join('\n'),
      2
    );
    assert.equal(keys.length, 2);
    assert.ok(keys[0].startsWith('src/a.ts [TS2322] '));
    assert.ok(keys[0].length < 130, 'message prefix truncated');
    assert.equal(keys[1], 'src/b.ts [TS1005] comma expected');
  });

  it('green run → no keys; nonzero exit with unparseable output → one synthetic stable key', () => {
    assert.deepEqual(parseTypecheckErrors('all good', 0), []);
    const a = parseTypecheckErrors('segfault', 1);
    const b = parseTypecheckErrors('other garbage', 1);
    assert.equal(a.length, 1);
    assert.deepEqual(a, b, 'synthetic key is stable across runs');
  });
});

describe('read/writeTypecheckBaseline', () => {
  it('round-trips error keys with a recordedAt stamp', () => {
    writeTypecheckBaseline(dir, ['src/a.ts [TS2345] Bad arg']);
    const b = readTypecheckBaseline(dir);
    assert.deepEqual(b.errors, ['src/a.ts [TS2345] Bad arg']);
    assert.notEqual(b.recordedAt, 'unknown');
  });

  it('returns null when missing, unparseable, or errors is not an array', () => {
    assert.equal(readTypecheckBaseline(dir), null);
    fs.writeFileSync(path.join(dir, TYPECHECK_BASELINE_FILE), 'not json');
    assert.equal(readTypecheckBaseline(dir), null);
    fs.writeFileSync(path.join(dir, TYPECHECK_BASELINE_FILE), JSON.stringify({ errors: 'nope' }));
    assert.equal(readTypecheckBaseline(dir), null);
  });

  it('CHECK_TYPECHECK_BASELINE=0 disables both read and write', () => {
    process.env.CHECK_TYPECHECK_BASELINE = '0';
    writeTypecheckBaseline(dir, []);
    assert.equal(fs.existsSync(path.join(dir, TYPECHECK_BASELINE_FILE)), false);
    delete process.env.CHECK_TYPECHECK_BASELINE;
    writeTypecheckBaseline(dir, []);
    process.env.CHECK_TYPECHECK_BASELINE = '0';
    assert.equal(readTypecheckBaseline(dir), null);
  });
});

describe('resolveTypecheckCommand — safe-env gating', () => {
  it('returns null when unconfigured', () => {
    assert.equal(resolveTypecheckCommand(), null);
  });

  it('rejects unsafe commands (shell metacharacters) — treated as unconfigured', () => {
    process.env.SCRIPT_TYPECHECK_COMMAND = 'tsc --noEmit; rm -rf /';
    assert.equal(resolveTypecheckCommand(), null);
    process.env.SCRIPT_TYPECHECK_COMMAND = 'tsc $(evil)';
    assert.equal(resolveTypecheckCommand(), null);
  });

  it('accepts an allowlisted command; toggle off wins', () => {
    process.env.SCRIPT_TYPECHECK_COMMAND = 'pnpm exec tsc --noEmit';
    assert.equal(resolveTypecheckCommand(), 'pnpm exec tsc --noEmit');
    process.env.CHECK_TYPECHECK_BASELINE = '0';
    assert.equal(resolveTypecheckCommand(), null);
  });
});

describe('splitTypecheckKeys', () => {
  it('splits by exact key membership', () => {
    const { netNew, preExisting } = splitTypecheckKeys(
      ['src/a.ts [TS1] old', 'src/b.ts [TS2] fresh'],
      ['src/a.ts [TS1] old']
    );
    assert.deepEqual(netNew, ['src/b.ts [TS2] fresh']);
    assert.deepEqual(preExisting, ['src/a.ts [TS1] old']);
  });
});

describe('assessTypecheck', () => {
  const ERR_A = 'src/a.ts(3,1): error TS2345: Bad arg';
  const ERR_B = 'src/b.ts(7,2): error TS2322: Wrong type';

  it('returns null (silent skip) when unconfigured — runner never invoked', () => {
    let called = false;
    const run = () => {
      called = true;
      return { output: '', exitCode: 0 };
    };
    assert.equal(assessTypecheck(dir, run), null);
    assert.equal(called, false);
  });

  it('returns null when CHECK_TYPECHECK_BASELINE=0 even if configured', () => {
    process.env.SCRIPT_TYPECHECK_COMMAND = 'tsc --noEmit';
    process.env.CHECK_TYPECHECK_BASELINE = '0';
    assert.equal(assessTypecheck(dir, fakeRun(ERR_A, 2)), null);
  });

  it('first run captures the baseline: net-new empty, errors reported as pre-existing', () => {
    process.env.SCRIPT_TYPECHECK_COMMAND = 'tsc --noEmit';
    const a = assessTypecheck(dir, fakeRun(ERR_A, 2));
    assert.equal(a.firstRun, true);
    assert.deepEqual(a.netNew, []);
    assert.equal(a.baselineCount, 1);
    assert.equal(a.currentCount, 1);
    assert.equal(a.preExisting.length, 1);
    assert.ok(fs.existsSync(path.join(dir, TYPECHECK_BASELINE_FILE)), 'baseline written');
  });

  it('subsequent run flags only the net-new key', () => {
    process.env.SCRIPT_TYPECHECK_COMMAND = 'tsc --noEmit';
    assessTypecheck(dir, fakeRun(ERR_A, 2)); // capture baseline
    const a = assessTypecheck(dir, fakeRun(`${ERR_A}\n${ERR_B}`, 2));
    assert.equal(a.firstRun, false);
    assert.equal(a.baselineCount, 1);
    assert.equal(a.currentCount, 2);
    assert.deepEqual(a.netNew, ['src/b.ts [TS2322] Wrong type']);
    assert.deepEqual(a.preExisting, ['src/a.ts [TS2345] Bad arg']);
  });

  it('same baseline error moved to a different line is NOT net-new (line-drift immunity)', () => {
    process.env.SCRIPT_TYPECHECK_COMMAND = 'tsc --noEmit';
    assessTypecheck(dir, fakeRun('src/a.ts(3,1): error TS2345: Bad arg', 2));
    const a = assessTypecheck(dir, fakeRun('src/a.ts(88,4): error TS2345: Bad arg', 2));
    assert.deepEqual(a.netNew, []);
    assert.equal(a.preExisting.length, 1);
  });

  it('zero net-new refreshes (ratchets down) the baseline to the current set', () => {
    process.env.SCRIPT_TYPECHECK_COMMAND = 'tsc --noEmit';
    assessTypecheck(dir, fakeRun(`${ERR_A}\n${ERR_B}`, 2)); // baseline: 2 errors
    assessTypecheck(dir, fakeRun(ERR_A, 2)); // one fixed → refresh
    const b = readTypecheckBaseline(dir);
    assert.deepEqual(b.errors, ['src/a.ts [TS2345] Bad arg']);
  });

  it('a regression does NOT rewrite the baseline (no ratchet up)', () => {
    process.env.SCRIPT_TYPECHECK_COMMAND = 'tsc --noEmit';
    assessTypecheck(dir, fakeRun(ERR_A, 2));
    assessTypecheck(dir, fakeRun(`${ERR_A}\n${ERR_B}`, 2));
    const b = readTypecheckBaseline(dir);
    assert.deepEqual(b.errors, ['src/a.ts [TS2345] Bad arg']);
  });
});

describe('typecheckSection / typecheckFailureReason', () => {
  it('null assessment → empty section (feature skipped, zero noise)', () => {
    assert.deepEqual(typecheckSection(null), []);
  });

  it('renders the counters line and net-new list', () => {
    const text = typecheckSection({
      cmd: 'tsc --noEmit',
      firstRun: false,
      baselineCount: 8,
      currentCount: 9,
      netNew: ['src/new.ts [TS2322] Wrong type'],
      preExisting: new Array(8).fill('x'),
    }).join('\n');
    assert.match(
      text,
      /\*\*Errors at baseline:\*\* 8 \| \*\*errors now:\*\* 9 \| \*\*net new from your changes:\*\* 1/
    );
    assert.match(text, /### Net-new typecheck errors \(1\)/);
    assert.match(text, /- src\/new\.ts \[TS2322\] Wrong type/);
  });

  it('pre-existing-only run renders the informational "not yours" line', () => {
    const text = typecheckSection({
      cmd: 'tsc --noEmit',
      firstRun: false,
      baselineCount: 8,
      currentCount: 8,
      netNew: [],
      preExisting: new Array(8).fill('x'),
    }).join('\n');
    assert.match(text, /8 pre-existing error\(s\) \(not yours\) — not blocking\./);
  });

  it('failure reason names the net-new keys and the pre-existing count', () => {
    const reason = typecheckFailureReason({
      netNew: ['src/new.ts [TS2322] Wrong type'],
      preExisting: ['a', 'b'],
    });
    assert.match(reason, /1 net-new error\(s\)/);
    assert.match(reason, /2 pre-existing, not yours/);
    assert.match(reason, /src\/new\.ts \[TS2322\] Wrong type/);
  });
});
