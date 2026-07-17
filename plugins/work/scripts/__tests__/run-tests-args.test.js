'use strict';

/**
 * run-tests.sh contract tests (GH-776): positional args become the file list
 * (previously ignored — a single-file request ran the full suite), the local
 * concurrency default is 1 with WORK_TEST_CONCURRENCY as the explicit
 * override, and .test-skip filtering still applies to explicit args.
 *
 * Uses the script's WORK_TEST_LIST_ONLY=1 mode: prints the resolved file list
 * plus `concurrency=<n>` and exits without running anything, so the contract
 * is assertable without spawning the real suite.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'run-tests.sh');

function runListOnly({ args = [], env = {}, cwd }) {
  const out = execFileSync('bash', [SCRIPT, ...args], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      WORK_TEST_LIST_ONLY: '1',
      CI: '',
      WORK_TEST_CONCURRENCY: '',
      ...env,
    },
  });
  const lines = out.trim().split('\n');
  const concurrencyLine = lines.pop();
  return { files: lines, concurrencyLine };
}

/** A tiny repo dir with two discoverable test files under plugins/. */
function makeFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-tests-args-'));
  fs.mkdirSync(path.join(dir, 'plugins', 'demo', '__tests__'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'demo', '__tests__', 'a.test.js'), '');
  fs.writeFileSync(path.join(dir, 'plugins', 'demo', '__tests__', 'b.test.js'), '');
  return dir;
}

describe('run-tests.sh argument and concurrency contract (GH-776)', () => {
  it('positional args become the file list verbatim', () => {
    const dir = makeFixtureRepo();
    try {
      const { files } = runListOnly({ args: ['x/one.test.js', 'y/two.test.js'], cwd: dir });
      assert.deepEqual(files, ['x/one.test.js', 'y/two.test.js']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no args discovers test files under plugins/', () => {
    const dir = makeFixtureRepo();
    try {
      const { files } = runListOnly({ cwd: dir });
      assert.deepEqual(files, [
        'plugins/demo/__tests__/a.test.js',
        'plugins/demo/__tests__/b.test.js',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('.test-skip filtering applies to explicit args too', () => {
    const dir = makeFixtureRepo();
    try {
      fs.writeFileSync(path.join(dir, '.test-skip'), 'one.test.js\n');
      const { files } = runListOnly({ args: ['x/one.test.js', 'y/two.test.js'], cwd: dir });
      assert.deepEqual(files, ['y/two.test.js']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('local concurrency defaults to 1', () => {
    const dir = makeFixtureRepo();
    try {
      const { concurrencyLine } = runListOnly({ cwd: dir });
      assert.equal(concurrencyLine, 'concurrency=1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('WORK_TEST_CONCURRENCY overrides the local default', () => {
    const dir = makeFixtureRepo();
    try {
      const { concurrencyLine } = runListOnly({ cwd: dir, env: { WORK_TEST_CONCURRENCY: '4' } });
      assert.equal(concurrencyLine, 'concurrency=4');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CI=true pins concurrency to 1 regardless of the override', () => {
    const dir = makeFixtureRepo();
    try {
      const { concurrencyLine } = runListOnly({
        cwd: dir,
        env: { CI: 'true', WORK_TEST_CONCURRENCY: '8' },
      });
      assert.equal(concurrencyLine, 'concurrency=1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
