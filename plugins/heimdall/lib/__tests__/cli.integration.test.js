// Integration tests for Heimdall lib/cli.js `resolveStoreDirs` four-kind support.
//
// Discovered by plugins/work/scripts/run-tests.sh.
// Manual: node --test plugins/heimdall/lib/__tests__/cli.integration.test.js
//
// Covers GH-541 Task 2 scenarios:
//   - resolveStoreDirs({ kind: 'bogus' }) returns error containing local|worktree|global|shared
//   - resolveStoreDirs({ kind: 'shared' }) returns the shared dir
//   - VALID_KINDS exported constant lists all four kinds

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cliPath = path.resolve(__dirname, '..', 'cli');
const lockStorePath = path.resolve(__dirname, '..', 'lock-store');

const { resolveStoreDirs, VALID_KINDS } = require(cliPath);
const { FOLDER } = require(lockStorePath);

let originalHome;
let base;
let fakeHome;

before(() => {
  originalHome = os.homedir();
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-cli-it-'));
  fakeHome = path.join(base, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;
});

after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(base, { recursive: true, force: true });
});

describe('resolveStoreDirs error string lists all four kinds', () => {
  it('returns error referencing local|worktree|global|shared for bogus kind', () => {
    const cwd = fs.mkdtempSync(path.join(base, 'bogus-'));
    const { dirs, error } = resolveStoreDirs({ cwd, kind: 'bogus' });
    assert.deepEqual(dirs, []);
    assert.ok(error, 'expected an error message');
    assert.match(error, /local\|worktree\|global\|shared/);
    assert.match(error, /bogus/);
  });
});

describe('resolveStoreDirs accepts kind=shared', () => {
  it('returns the shared dir at ~/.claude/heimdall-shared', () => {
    const cwd = fs.mkdtempSync(path.join(base, 'shared-'));
    const { dirs, error } = resolveStoreDirs({ cwd, kind: 'shared' });
    assert.equal(error, null, `expected no error, got: ${error}`);
    const expected = path.join(os.homedir(), '.claude', `${FOLDER}-shared`);
    assert.deepEqual(dirs, [expected]);
  });
});

describe('VALID_KINDS export', () => {
  it('exports the four valid kinds in precedence order', () => {
    assert.deepEqual(VALID_KINDS, ['local', 'worktree', 'global', 'shared']);
  });
});
