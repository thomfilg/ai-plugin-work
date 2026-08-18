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
  if (/node (?:--test|--experimental-test)/.test(testScript)) {
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

/** Try one candidate JSON slice for reporter counts. */
function tryReporterDoc(candidate) {
  try {
    const doc = JSON.parse(candidate);
    if (typeof doc.numTotalTests !== 'number') return null;
    return { testsRan: doc.numTotalTests, failures: doc.numFailedTests || 0 };
  } catch {
    return null;
  }
}

/**
 * Parse vitest/jest --json output. Returns null when unparseable.
 * Runners occasionally print warnings (which may contain `{`) before the
 * JSON blob, so anchoring on the FIRST `{` is not enough: fall back to
 * scanning lines from the END for the JSON document.
 */
function parseJsonReporter(output) {
  const start = output.indexOf('{');
  if (start !== -1) {
    const fromFirst = tryReporterDoc(output.slice(start));
    if (fromFirst) return fromFirst;
  }
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    const fromLine = tryReporterDoc(line);
    if (fromLine) return fromLine;
  }
  return null;
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

/**
 * Structured-reporter flag appended to a repo-configured test command so the
 * run still yields parseable counts rather than exit-code-only grade.
 */
const REPORTER_FLAG = {
  vitest: '--reporter=json',
  jest: '--json',
  'node-test': '--test-reporter=tap',
};

/**
 * Shell syntax that means a flag appended to the END of the template would not
 * reach the test runner: pipelines, chains, redirects, command substitution.
 * `$VAR` is deliberately absent — templates routinely reference $CHANGED_FILES.
 */
const CHAINED_SYNTAX = /[|&;<>]|\$\(|`/;

/** Leading strict-mode wrapper (`set -euo pipefail; …`) — see withReporterFlag. */
const STRICT_PREFIX = /^\s*set\s+[-+][^;]*;\s*/;

/**
 * Append the structured-reporter flag only when it will actually land on the
 * test runner.
 *
 * The flag is appended to the whole template, so it reaches whatever command
 * comes LAST. For `pnpm test:unit` — or `set -euo pipefail; pnpm test:unit`,
 * where the wrapper is a prefix and the runner is still last — that is the
 * runner. For `pnpm test:unit | tee run.log` it is `tee`, which exits non-zero
 * on an unknown option:
 *
 *     tee: unrecognized option '--reporter=json'
 *
 * Under the `pipefail` these templates carry, that fails the whole run and the
 * verifier reads it as "tests do not pass on head" — the same false
 * contradiction this feature removes, reintroduced by its own instrumentation.
 *
 * So when the template chains, the command runs VERBATIM and unflagged. The
 * run is still the repo's own — which is the point — and interpretRun's
 * `reporterKind: 'exit-code-only'` path already grades it honestly instead of
 * inventing counts.
 */
function withReporterFlag(template, flag) {
  if (!flag) return template;
  if (CHAINED_SYNTAX.test(template.replace(STRICT_PREFIX, ''))) return template;
  return `${template} ${flag}`;
}

/** Package-manager subcommands that are not script names. */
const PM_SUBCOMMANDS = new Set(['exec', 'dlx', 'x', 'run-script']);

/**
 * Guard: a configured template is only usable in a repo that can actually run
 * it. The variable is exported process-wide (direnv), so it is also inherited
 * by runs against unrelated directories — notably this verifier's own temp
 * fixture repos, which have no such script. Applying it blindly there turns a
 * healthy fixture run into a spurious failure, so fall back to the built-in
 * table whenever the target repo does not declare the referenced script.
 *
 * Non-script commands (`pnpm exec …`, `npx …`, a bare binary) are trusted
 * as-is — there is nothing to look up.
 */
function repoCanRunTemplate(cwd, template) {
  const match = template.trim().match(/^(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/);
  if (!match || PM_SUBCOMMANDS.has(match[1])) return true;
  if (!cwd) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    return Boolean(pkg.scripts && pkg.scripts[match[1]]);
  } catch {
    return false;
  }
}

/**
 * Build the run from the repo-configured test command when one is exported
 * (`.envrc`: TEST_UNIT_COMMAND, falling back to TEST_COMMAND).
 *
 * Phase-mode `task-next.js` already runs tests as
 * `CHANGED_FILES="…" eval "$TEST_UNIT_COMMAND"`. The outcome verifier must use
 * the SAME command, or it resolves a different runner config than the repo
 * intends. Concrete failure this fixes: in a repo whose ROOT `vitest.config.ts`
 * is the integration lane (`include: ['**\/*.integration.test.ts(x)']`) with
 * unit tests in a separate `vitest.unit.config.ts`, the hardcoded
 * `vitest run <unit-file>` collects 0 tests and exits non-zero, producing a
 * false I4 "tests do not pass on head" contradiction against a green suite.
 *
 * Returns null when nothing is configured, so the caller falls back to the
 * RUNNER_COMMANDS table (previous behavior, unchanged).
 */
function configuredCommand(files, runner, cwd) {
  const template = process.env.TEST_UNIT_COMMAND || process.env.TEST_COMMAND;
  if (!template || !template.trim()) return null;
  if (!repoCanRunTemplate(cwd, template)) return null;
  const command = withReporterFlag(template, REPORTER_FLAG[runner]);
  return {
    // `bash -lc`, NOT `sh -c` — the same invocation tdd-phase-state/io.js and
    // task-next.js runTest() use, for the reason spelled out there: /bin/sh is
    // dash on Debian/Ubuntu, and the strict-mode wrappers these templates carry
    // (`set -euo pipefail; …`, GH-392 §P0#3) die on dash with "set: Illegal
    // option -o pipefail". Running the repo's own command under a shell that
    // cannot execute it would manufacture the exact false "tests do not pass on
    // head" this function exists to remove. `bash` stays PATH-resolved rather
    // than pinned to /bin/bash so hosts that keep it elsewhere (NixOS, macOS
    // homebrew) resolve the same binary as the rest of the pipeline.
    cmd: 'bash',
    args: ['-lc', command],
    // `$CHANGED_FILES` in the template expands from env (set by the caller).
    parse: runner === 'node-test' ? parseNodeTestSummary : parseJsonReporter,
    changedFiles: files.join(' '),
  };
}

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
 * Drop only the `--test*` flag family (and their `=`/space-separated values)
 * from a NODE_OPTIONS string, preserving unrelated flags such as
 * `--max-old-space-size` or `--require` preloads. Returns '' when nothing
 * survives (caller then unsets the variable).
 */
function scrubTestFlags(nodeOptions) {
  if (!nodeOptions || typeof nodeOptions !== 'string') return '';
  const tokens = nodeOptions.split(/\s+/).filter(Boolean);
  const kept = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (/^--(?:experimental-)?test/.test(token)) {
      // Space-separated flag value (e.g. `--test-reporter tap`) travels with it.
      if (!token.includes('=') && tokens[i + 1] && !tokens[i + 1].startsWith('-')) i += 1;
      continue;
    }
    kept.push(token);
  }
  return kept.join(' ');
}

/**
 * Child environment for a derived test run.
 *
 * Scrub test-runner context vars: when the verifier itself runs under
 * `node --test`, an inherited NODE_TEST_CONTEXT flips the child into the
 * parent's reporter protocol and the TAP summary disappears. NODE_OPTIONS
 * keeps its non-test flags (heap size, --require/--import preloads the suite
 * may depend on) — only the --test* family hijacks the reporter.
 *
 * @param {string|undefined} changedFiles - repo-configured templates address
 *   the derived files as `$CHANGED_FILES`; omitted for the built-in table.
 */
function childEnv(changedFiles) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const scrubbed = scrubTestFlags(env.NODE_OPTIONS);
  if (scrubbed) env.NODE_OPTIONS = scrubbed;
  else delete env.NODE_OPTIONS;
  if (changedFiles !== undefined) env.CHANGED_FILES = changedFiles;
  return env;
}

/**
 * Run the derived test files with the detected runner.
 * @returns the run-observation shape (see module docblock).
 */
function runDerivedTests({ cwd, files, runner, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  // The repo's own configured command wins over the built-in table: it is the
  // only one guaranteed to resolve the config the repo actually uses.
  const configured = configuredCommand(files, runner, cwd);
  const make = RUNNER_COMMANDS[runner];
  if (!configured && !make) {
    return {
      attempted: true,
      supported: false,
      outcome: 'not-run',
      reporterKind: 'none',
      notes: `unknown runner: ${runner || 'none detected'}`,
    };
  }
  const { cmd, args, parse, changedFiles } = configured || make(files);
  const env = childEnv(changedFiles);
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
  scrubTestFlags,
  parseNodeTestSummary,
  parseJsonReporter,
  withReporterFlag,
  configuredCommand,
  runDerivedTests,
  DEFAULT_TIMEOUT_MS,
};
