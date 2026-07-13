'use strict';

/**
 * tdd-phase-state/io.js
 *
 * Pure CLI I/O + test-runner + argument-parsing helpers extracted from
 * tdd-phase-state.js (GH-610 static-quality refactor). Behavior is
 * byte-for-byte identical to the original inline helpers — exit codes,
 * stdout/stderr strings, parse semantics, and error messages are preserved.
 */

const { spawnSync } = require('child_process');

function errorExit(message) {
  process.stderr.write(JSON.stringify({ error: true, message }) + '\n');
  process.exit(1);
}

function successOut(data) {
  process.stdout.write(JSON.stringify(data) + '\n');
}

// Commands that are NOT real test runners — used to fake TDD evidence
const FAKE_CMD_PATTERNS = [
  /^\s*exit\s+\d/i, // exit 1
  /^\s*echo\b/i, // echo anything
  /^\s*true\s*$/i, // true
  /^\s*false\s*$/i, // false
  /^\s*:\s*$/i, // : (no-op)
  /^\s*test\s+-[a-z]\s/i, // test -f (file tests, not test runners)
  /^\s*\/bin\/(true|false)\s*$/i, // /bin/true, /bin/false
];

function parseCmd(args) {
  const cmdIdx = args.indexOf('--cmd');
  if (cmdIdx === -1 || cmdIdx + 1 >= args.length) {
    return null;
  }
  const cmd = args[cmdIdx + 1];

  // Block fake/dummy test commands
  if (FAKE_CMD_PATTERNS.some((re) => re.test(cmd))) {
    errorExit(
      `Fake test command detected: "${cmd}". ` +
        'The --cmd argument must be a real test runner (e.g., "pnpm test", "npx vitest", "node --test").'
    );
  }

  return cmd;
}

function parseTask(args) {
  const taskIdx = args.indexOf('--task');
  if (taskIdx === -1 || taskIdx + 1 >= args.length) {
    return undefined;
  }
  const val = parseInt(args[taskIdx + 1], 10);
  if (!Number.isInteger(val) || val < 1)
    throw new Error('Invalid --task value: ' + args[taskIdx + 1]);
  return val;
}

function safeParseTask(args) {
  try {
    return parseTask(args);
  } catch (e) {
    errorExit(e.message);
  }
}

function parseCategory(args) {
  const idx = args.indexOf('--category');
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

function runTestCommand(cmd) {
  return runTestCommandWithOutput(cmd).exitCode;
}

// GH-584 — recorder-side test-command timeout. Default 5 minutes; override
// via TDD_PHASE_TEST_TIMEOUT_MS (mirrors task-next.js's
// TASK_NEXT_TEST_TIMEOUT_MS), primarily so tests can exercise the
// hang-rejection path without waiting minutes.
const DEFAULT_TEST_TIMEOUT_MS = 300000;

function resolveTestTimeoutMs() {
  const val = Number(process.env.TDD_PHASE_TEST_TIMEOUT_MS);
  return Number.isFinite(val) && val > 0 ? val : DEFAULT_TEST_TIMEOUT_MS;
}

/** Human-readable timeout label: "5min" for whole minutes, else seconds. */
function formatTestTimeout(ms) {
  if (ms % 60000 === 0) return `${ms / 60000}min`;
  return `${Math.round(ms / 1000)}s`;
}

/**
 * GH-584 — did this spawnSync result die at the timeout? spawnSync surfaces a
 * timeout as error.code === 'ETIMEDOUT' (with error.killed) and/or
 * status === null plus the kill signal.
 */
function spawnResultTimedOut(result) {
  if (result.error && (result.error.code === 'ETIMEDOUT' || result.error.killed)) return true;
  return result.status === null && (result.signal === 'SIGTERM' || result.signal === 'SIGKILL');
}

/**
 * Like runTestCommand but also captures stdout+stderr so callers can
 * inspect the test runner's summary line (passed/skipped/failed counts).
 * Used by GREEN/REFACTOR recording to reject "all-skipped" false positives
 * (RC-B in implement-gate stuckness investigation: a fully-skipped spec
 * exits 0 and used to silently record as legitimate GREEN evidence).
 */
function runTestCommandWithOutput(cmd) {
  // Use spawnSync (not execSync) so we capture BOTH stdout AND stderr on
  // success. execSync only returns stdout when exit code is 0, which means
  // the RC-B "all-skipped" guard silently fails for Jest/Vitest — both
  // print their summary lines to stderr.
  //
  // Use `bash -lc` explicitly rather than `{ shell: true }`. Node's
  // `shell: true` selects `/bin/sh`, which on Debian/Ubuntu is `dash` —
  // a POSIX shell that does NOT support `set -o pipefail`. Callers
  // (e.g. task-next.js recordEvidence) forward strict-mode-wrapped
  // commands (`set -euo pipefail; ...`) per GH-392 §P0#3 so that
  // middle-of-chain failures surface as non-zero. Running those under
  // dash would fail with "set: Illegal option -o pipefail". bash also
  // matches what task-next.js's own runTest() uses for the initial
  // execution, keeping recorder and caller in lockstep.
  const timeoutMs = resolveTestTimeoutMs();
  const result = spawnSync('bash', ['-lc', cmd], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });
  // GH-584: a run killed by the timeout is a HANG, not a test outcome. Flag
  // it so callers reject instead of misreading exit!=0 as a failing (RED)
  // run.
  const timedOut = spawnResultTimedOut(result);
  let stderr = result.stderr || '';
  if (timedOut) {
    // GH-584: the diagnostic must land in result.stderr — callers embed it in
    // rejection messages — not only on the host process's stderr.
    const note = `Test command timed out after ${formatTestTimeout(timeoutMs)}: ${cmd}\n`;
    stderr = stderr ? `${stderr}\n${note}` : note;
    process.stderr.write(note);
  }
  return {
    exitCode: result.status === null ? 1 : result.status,
    stdout: result.stdout || '',
    stderr,
    timedOut,
    timeoutMs,
  };
}

/**
 * Extract the last `N <word>` integer from a runner summary. Runners often
 * print intermediate updates plus a final summary line; the summary wins, so
 * we use the LAST occurrence.
 */
function lastCount(output, re) {
  const matches = output.match(re);
  if (!matches || matches.length === 0) return null;
  const m = matches[matches.length - 1].match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Inspect a test runner's stdout/stderr for a summary line indicating
 * pass/skip counts. Returns { passed, skipped, parsed } where `parsed` is
 * true only if we found a recognizable summary. Be lenient on format —
 * vitest, jest, mocha, playwright all phrase summaries differently — but
 * strict on meaning: only return parsed=true when we're confident.
 */
function parseTestSummary(output) {
  if (!output || typeof output !== 'string') return { passed: 0, skipped: 0, parsed: false };
  let passed = 0;
  let skipped = 0;
  let parsed = false;
  // vitest: "Tests  4 passed | 2 skipped (6)"
  // jest: "Tests:  4 passed, 2 skipped, 6 total"
  // mocha: "4 passing", "2 pending"
  // playwright: "4 passed (10s)", "2 skipped"
  // Generic: capture any `N passed` and `N skipped|pending` anywhere.
  const passedCount = lastCount(output, /(\d+)\s+passed/gi);
  if (passedCount !== null) {
    passed = passedCount;
    parsed = true;
  }
  // Mocha uses "passing" instead of "passed"
  if (!parsed) {
    const passingCount = lastCount(output, /(\d+)\s+passing/gi);
    if (passingCount !== null) {
      passed = passingCount;
      parsed = true;
    }
  }
  const skippedCount = lastCount(output, /(\d+)\s+(?:skipped|pending)/gi);
  if (skippedCount !== null) {
    skipped = skippedCount;
    parsed = true;
  }
  return { passed, skipped, parsed };
}

function getCurrentCycleRecord(state) {
  let record = state.cycles.find((c) => c.cycle === state.currentCycle);
  if (!record) {
    record = { cycle: state.currentCycle };
    state.cycles.push(record);
  }
  return record;
}

module.exports = {
  errorExit,
  successOut,
  FAKE_CMD_PATTERNS,
  parseCmd,
  parseTask,
  safeParseTask,
  parseCategory,
  runTestCommand,
  runTestCommandWithOutput,
  resolveTestTimeoutMs,
  formatTestTimeout,
  parseTestSummary,
  getCurrentCycleRecord,
};
