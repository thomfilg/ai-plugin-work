'use strict';

/**
 * task-verify/collect/runner.js — runner adapters with structured reporters
 * first (GH-755; plan §5.2 I4).
 *
 * Adapters produce the corpus `headRun`/`baseRun` observation shape:
 *   { attempted, supported, outcome, testsRan, failures, exitCode,
 *     reporterKind, notes? }
 *
 * Structured counts come from the runner's own reporter (node --test TAP,
 * vitest/jest --json). Exit-code-only interpretation is emitted with
 * `reporterKind: 'exit-code-only'`, which the verdict engine treats as
 * UNVERIFIED-grade (no-structured-reporter flag). An unknown runner is
 * `supported: false` — a mechanism failure, never a contradiction.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Detect the repo's test runner from package.json. */
function detectRunner(repoDir) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.vitest) return 'vitest';
  if (deps.jest) return 'jest';
  const testScript = (pkg.scripts && pkg.scripts.test) || '';
  if (deps['node:test'] !== undefined || /node (?:--test|--experimental-test)/.test(testScript)) {
    return 'node-test';
  }
  // A bare repo with no framework often still runs node --test files fine.
  if (testScript.includes('node --test') || testScript.includes('run-tests')) return 'node-test';
  return null;
}

/** Parse node --test TAP/spec summary counts. Returns null when absent. */
function parseNodeTestSummary(output) {
  const tests = output.match(/^(?:#|ℹ) tests (\d+)/m);
  const fail = output.match(/^(?:#|ℹ) fail (\d+)/m);
  if (!tests) return null;
  return {
    testsRan: Number.parseInt(tests[1], 10),
    failures: fail ? Number.parseInt(fail[1], 10) : 0,
  };
}

/** Parse vitest/jest --json output. Returns null when unparseable. */
function parseJsonReporter(output) {
  const start = output.indexOf('{');
  if (start === -1) return null;
  try {
    const doc = JSON.parse(output.slice(start));
    if (typeof doc.numTotalTests !== 'number') return null;
    return { testsRan: doc.numTotalTests, failures: doc.numFailedTests || 0 };
  } catch {
    return null;
  }
}

const RUNNER_COMMANDS = {
  'node-test': (files) => ({
    cmd: process.execPath,
    args: ['--test', '--test-reporter=tap', ...files],
    parse: parseNodeTestSummary,
  }),
  vitest: (files) => ({
    cmd: 'npx',
    args: ['--no-install', 'vitest', 'run', '--reporter=json', ...files],
    parse: parseJsonReporter,
  }),
  jest: (files) => ({
    cmd: 'npx',
    args: ['--no-install', 'jest', '--json', ...files],
    parse: parseJsonReporter,
  }),
};

/** Map a finished (non-hang) spawn into the run-observation shape. */
function interpretRun(spawned, parse) {
  const output = `${spawned.stdout || ''}\n${spawned.stderr || ''}`;
  const exitCode = spawned.status;
  const counts = parse(output);
  if (counts) {
    return {
      attempted: true,
      supported: true,
      outcome: counts.failures > 0 || exitCode !== 0 ? 'fail' : 'pass',
      testsRan: counts.testsRan,
      failures: counts.failures,
      exitCode,
      reporterKind: 'structured',
    };
  }
  // No structured counts — exit-code-grade only. Zero-test load crashes land
  // here too (runner died before emitting a summary).
  return {
    attempted: true,
    supported: true,
    outcome: exitCode === 0 ? 'pass' : 'error',
    exitCode,
    reporterKind: 'exit-code-only',
    notes: 'no structured reporter output',
  };
}

/**
 * Run the derived test files with the detected runner.
 * @returns the run-observation shape (see module docblock).
 */
function runDerivedTests({ cwd, files, runner, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const make = RUNNER_COMMANDS[runner];
  if (!make) {
    return {
      attempted: true,
      supported: false,
      outcome: 'not-run',
      reporterKind: 'none',
      notes: `unknown runner: ${runner || 'none detected'}`,
    };
  }
  const { cmd, args, parse } = make(files);
  // Scrub test-runner context vars: when the verifier itself runs under
  // `node --test`, an inherited NODE_TEST_CONTEXT flips the child into the
  // parent's reporter protocol and the TAP summary disappears.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const spawned = spawnSync(cmd, args, {
    cwd,
    env,
    encoding: 'utf-8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (spawned.error && spawned.error.code === 'ETIMEDOUT') {
    return {
      attempted: true,
      supported: true,
      outcome: 'hang',
      testsRan: 0,
      exitCode: null,
      reporterKind: 'none',
      notes: `test run timed out after ${timeoutMs}ms — a hang is not a result`,
    };
  }
  if (spawned.error) {
    return {
      attempted: true,
      supported: false,
      outcome: 'error',
      reporterKind: 'none',
      notes: `runner failed to spawn: ${spawned.error.message}`,
    };
  }
  return interpretRun(spawned, parse);
}

module.exports = {
  detectRunner,
  parseNodeTestSummary,
  parseJsonReporter,
  runDerivedTests,
  DEFAULT_TIMEOUT_MS,
};
