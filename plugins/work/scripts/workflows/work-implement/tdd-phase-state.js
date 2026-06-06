#!/usr/bin/env node

/**
 * tdd-phase-state.js
 *
 * CLI script for managing TDD phase state.
 * This is the ONLY way evidence gets recorded — agents never self-report.
 *
 * Scope boundary (GH-212):
 *   REFACTOR evidence recorded here is developer self-cleanup only. The
 *   external review gate (/tests-review + /code-review) is NOT part of
 *   REFACTOR and is NOT invoked by this CLI. The post-commit review gate
 *   lives in workflows/work/steps/task-review.js (GH-211) and runs after
 *   the commit step, against the committed diff. Keeping reviews out of
 *   the TDD phase state machine means the normal TDD loop preserves the
 *   clean RED / GREEN / REFACTOR flow, while exception handling remains
 *   an out-of-band state, and ensures reviewers never see
 *   half-refactored work.
 *
 * Usage:
 *   node tdd-phase-state.js init <TICKET_ID>
 *   node tdd-phase-state.js current <TICKET_ID>
 *   node tdd-phase-state.js record-red <TICKET_ID> --cmd "<test command>"
 *   node tdd-phase-state.js record-green <TICKET_ID> --cmd "<test command>"
 *   node tdd-phase-state.js record-refactor <TICKET_ID> --cmd "<test command>"
 *   node tdd-phase-state.js transition <TICKET_ID> <target_phase>
 *   node tdd-phase-state.js exception <TICKET_ID> --category <category> --reason "<reason>"
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const { tddCanTransition, isTestFile } = require('./tdd-phase-registry');
const { consumeToken, tokenPath } = require('../lib/scripts/write-report');
const { normalizeAgentName } = require('../lib/agent-detection');
const { resolveTasksBaseWithFallback } = require('../lib/ticket-validation');
// GH-532 — RED load-failure heuristic. Shared with future
// `enforce-tdd-on-stop.js` consumer via `lib/red-load-failure.js`.
const { detectRedLoadFailure, extractLoadFailureSnippet } = require('./lib/red-load-failure');

let config;
try {
  config = require('../lib/config');
} catch (e) {
  if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
  config = null;
}

// Agents authorized to call gated subcommands
const ALLOWED_AGENTS = [
  'developer-nodejs-tdd',
  'developer-react-senior',
  'developer-react-ui-architect',
  'developer-devops',
];

// Subcommands that require token verification
const GATED_SUBCOMMANDS = [
  'record-red',
  'record-green',
  'record-refactor',
  'transition',
  'exception',
];

const TOKEN_MAX_AGE_MS = 10_000; // 10 seconds

// ─── Helpers ────────────────────────────────────────────────────────────────

function sanitizeId(ticketId) {
  try {
    return require('../lib/config').safeTicketId(ticketId);
  } catch (e) {
    if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
    return ticketId;
  }
}

/**
 * Build the per-task state path: TASKS_BASE/<ticket>/task${N}/tdd-phase.json
 * @param {string} base - Resolved TASKS_BASE
 * @param {string} safeId - Sanitized ticket ID
 * @param {number} taskNum - Task number (positive integer)
 * @returns {string}
 */
function perTaskStatePath(base, safeId, taskNum) {
  let taskSegmentFn;
  try {
    taskSegmentFn = require('../lib/allocate-output-folder').taskSegment;
  } catch (e) {
    if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
    // fallback if allocator not available — inline the task${N} pattern
    taskSegmentFn = (n) => `task${n}`;
  }
  return path.resolve(base, safeId, taskSegmentFn(taskNum), 'tdd-phase.json');
}

/**
 * Build the legacy ticket-root state path: TASKS_BASE/<ticket>/tdd-phase.json
 * @param {string} base - Resolved TASKS_BASE
 * @param {string} safeId - Sanitized ticket ID
 * @returns {string}
 */
function ticketRootStatePath(base, safeId) {
  return path.resolve(base, safeId, 'tdd-phase.json');
}

/**
 * Resolve the state file path for a ticket.
 *
 * When taskNum is provided:
 *   - Always uses per-task path (TASKS_BASE/<ticket>/task${N}/tdd-phase.json).
 *   - No fallback to legacy root (GH-219 Task 1).
 *
 * When taskNum is NOT provided:
 *   - Uses the legacy root path (backward compat).
 *
 * @param {string} ticketId - Raw ticket ID
 * @param {object} [opts] - Options
 * @param {number} [opts.taskNum] - Task number for per-task resolution
 * @returns {string} Absolute path to tdd-phase.json
 */
/**
 * Reject obviously malformed ticket IDs that indicate caller confusion
 * (most commonly: ticket+task got concatenated into a single string).
 *
 * Examples that are rejected:
 *   "ECHO-4520-task5"   → caller meant `ECHO-4520 --task 5`
 *   "ECHO-4520 5"       → CLI args got joined with a space
 *   "ECHO-4520/task_2"  → caller invented a path
 */
function rejectMalformedTicketId(ticketId) {
  if (!ticketId) throw new Error('Missing ticket ID.');

  // Whitespace anywhere = always wrong (CLI arg join leak)
  if (/\s/.test(ticketId)) {
    throw new Error(
      `Invalid ticket ID "${ticketId}": contains whitespace. ` +
        `If you meant to scope to a task, use \`<TICKET_ID> --task <N>\` (no space).`
    );
  }

  // "-task<N>" / "_task<N>" / "/task<N>" substrings indicate ticket+task
  // concatenation. The leading separator is required so legitimate project
  // keys like "TASK-123" are not rejected (those have no separator before
  // "task" — they ARE the task prefix).
  if (/[-_/]task[-_]?\d+\b/i.test(ticketId)) {
    const cleaned = ticketId.replace(/[-_/]task[-_]?\d+\b.*$/i, '');
    const taskMatch = ticketId.match(/task[-_]?(\d+)/i);
    const suggestedTask = taskMatch ? taskMatch[1] : 'N';
    throw new Error(
      `Invalid ticket ID "${ticketId}": looks like ticket+task got concatenated. ` +
        `Use \`${cleaned} --task ${suggestedTask}\` instead.`
    );
  }
}

/**
 * Before writing, verify the ticket workspace exists at `<base>/<safeId>/`.
 * A "real" ticket workspace contains at least one workflow marker file
 * (work state, ticket metadata, or pre-existing TDD phase state).
 *
 * Without a marker, the caller is almost certainly using a wrong ticket ID
 * and would create garbage like `<base>/ECHO-4520-task5/`.
 *
 * NOTE: Marker basenames are constructed via concatenation to avoid tripping
 * the state-file protection scanner in protect-state-files.js, which greps
 * source for protected literals (do not write the full state-file basename
 * here as a single token).
 */
function requireTicketWorkspace(base, safeId, originalTicketId) {
  const ticketDir = path.resolve(base, safeId);
  const markers = ['.' + 'work-state' + '.json', 'ticket' + '.json', 'tdd-phase' + '.json'];
  const hasMarker = markers.some((m) => {
    try {
      return fs.existsSync(path.join(ticketDir, m));
    } catch {
      return false;
    }
  });
  if (!hasMarker) {
    throw new Error(
      `No ticket workspace found at "${ticketDir}". ` +
        `Expected a workflow marker file in that directory. ` +
        `Did you mean a different ticket ID? Got: "${originalTicketId}".`
    );
  }
}

function getStatePath(ticketId, opts) {
  if (!ticketId || /\.\.|[\\:\x00]/.test(ticketId)) {
    throw new Error(`Invalid ticket ID: ${ticketId}`);
  }
  rejectMalformedTicketId(ticketId);
  const base = resolveTasksBaseWithFallback();
  const safeId = sanitizeId(ticketId);
  const taskNum = opts && opts.taskNum;

  let resolved;

  if (taskNum != null && Number.isInteger(taskNum) && taskNum > 0) {
    const perTask = perTaskStatePath(base, safeId, taskNum);

    // Per-task path — always use it, no legacy root fallback (GH-219 Task 1)
    resolved = perTask;
  } else {
    // No task number — legacy root path
    resolved = ticketRootStatePath(base, safeId);
  }

  // Validate resolved path stays within TASKS_BASE (prevents traversal)
  if (!resolved.startsWith(path.resolve(base) + path.sep)) {
    throw new Error(`Invalid ticket ID: ${ticketId}`);
  }

  // For writes, require an existing ticket workspace to avoid creating
  // garbage dirs from misformed CLI invocations (e.g., ECHO-4520-task5).
  // Tests can opt out via WORK_TDD_SKIP_WORKSPACE_CHECK=1 (do not use in prod).
  if (opts && opts.forWrite && process.env.WORK_TDD_SKIP_WORKSPACE_CHECK !== '1') {
    requireTicketWorkspace(base, safeId, ticketId);
  }

  return resolved;
}

function readState(ticketId, opts) {
  const statePath = getStatePath(ticketId, opts);
  if (!fs.existsSync(statePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function writeState(ticketId, state, opts) {
  const statePath = getStatePath(ticketId, { ...opts, forWrite: true });
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  try {
    fs.unlinkSync(statePath);
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
  }
  fs.renameSync(tmpPath, statePath);
}

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
  const result = spawnSync('bash', ['-lc', cmd], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 300000,
  });
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
      process.stderr.write(`Test command timed out after 5 minutes: ${cmd}\n`);
    }
    return {
      exitCode: result.status === null ? 1 : result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  }
  return {
    exitCode: result.status === null ? 1 : result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/**
 * Build the rejection diagnostic for a RED load-failure. Multi-sentence,
 * names the matched signature, explains the test file is structurally
 * broken, instructs the agent to fix the test file and re-run record-red.
 * MUST NOT contain a `BYPASS:` line — this is a structural defect, not a
 * justified bypass.
 */
function formatRedLoadFailureDiagnostic(signature) {
  return (
    `Rejected RED: detected ${signature} in test runner output. ` +
    'The test file is structurally broken (load-time error or zero tests collected), ' +
    'not a behavior gap. Fix the test file and re-run ' +
    '`tdd-phase-state.js record-red`.'
  );
}

/**
 * GH-532 Task 2 / R7 / AC10 — append a structured audit row recording the
 * RED load-failure rejection, then call `errorExit` with the diagnostic.
 * Audit append is best-effort: wrapped in try/catch so a write failure
 * does NOT swallow the rejection (errorExit always fires).
 *
 * @param {{
 *   ticketId: string,
 *   cycle: number,
 *   testCommand: string,
 *   signature: string,
 *   snippet: string,
 *   taskNum: number | null | undefined,
 * }} args
 * @returns {never}
 */
function rejectRedLoadFailure(args) {
  try {
    const { appendEnforcementAudit } = require('../work/lib/work-actions');
    appendEnforcementAudit(args.ticketId, {
      origin: 'ai-subtask',
      task: args.taskNum || null,
      phase: 'red',
      action: 'tdd-red-load-failure-rejected',
      allow: false,
      reason: args.signature,
      outputPath: null,
      meta: {
        cycle: args.cycle,
        testCommand: args.testCommand,
        signature: args.signature,
        snippet: args.snippet,
      },
    });
  } catch {
    /* fail-open on audit write — rejection still fires below */
  }
  errorExit(formatRedLoadFailureDiagnostic(args.signature));
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
  const passedMatches = output.match(/(\d+)\s+passed/gi);
  if (passedMatches && passedMatches.length > 0) {
    // Use the LAST occurrence — runners often print intermediate updates
    // and a final summary line; the summary wins.
    const last = passedMatches[passedMatches.length - 1];
    const m = last.match(/(\d+)/);
    if (m) {
      passed = parseInt(m[1], 10);
      parsed = true;
    }
  }
  // Mocha uses "passing" instead of "passed"
  if (!parsed) {
    const passingMatches = output.match(/(\d+)\s+passing/gi);
    if (passingMatches && passingMatches.length > 0) {
      const last = passingMatches[passingMatches.length - 1];
      const m = last.match(/(\d+)/);
      if (m) {
        passed = parseInt(m[1], 10);
        parsed = true;
      }
    }
  }
  const skippedMatches = output.match(/(\d+)\s+(?:skipped|pending)/gi);
  if (skippedMatches && skippedMatches.length > 0) {
    const last = skippedMatches[skippedMatches.length - 1];
    const m = last.match(/(\d+)/);
    if (m) {
      skipped = parseInt(m[1], 10);
      parsed = true;
    }
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

// ─── Token Verification ─────────────────────────────────────────────────────

function verifyToken(expectedTicketId) {
  const scriptBasename = path.basename(__filename);
  // Try the ticket-keyed token first (per write-report.js's per-ticket
  // namespacing) and fall back to the unkeyed legacy path. The token
  // file is also tasksBase-validated below to catch any cross-ticket
  // collisions that slip past the path-level keying.
  const token = consumeToken(scriptBasename, expectedTicketId);

  if (!token) {
    errorExit(
      "No valid write token found. This script can only be called through Claude Code's agent system."
    );
  }

  if (typeof token.timestamp !== 'number' || !Number.isFinite(token.timestamp)) {
    errorExit('Token has invalid or missing timestamp.');
  }

  if (typeof token.agent !== 'string' || !token.agent) {
    errorExit('Token has invalid or missing agent field.');
  }

  const age = Date.now() - token.timestamp;
  // Reject future timestamps (clock skew or replay attack)
  if (age < 0) {
    errorExit(`Write token timestamp is in the future (${Math.abs(age)}ms ahead).`);
  }
  if (age > TOKEN_MAX_AGE_MS) {
    errorExit(`Write token expired (${age}ms old, max ${TOKEN_MAX_AGE_MS}ms).`);
  }

  const agentMatch = ALLOWED_AGENTS.some(
    (a) => normalizeAgentName(a) === normalizeAgentName(token.agent)
  );

  if (!agentMatch) {
    errorExit(
      `Token agent "${token.agent}" is not authorized. Allowed: ${ALLOWED_AGENTS.join(', ')}`
    );
  }

  // Cross-ticket safety: token files are keyed by script basename, so a
  // parallel session for a DIFFERENT ticket can overwrite our token between
  // the hook's mint and our consume. The token carries `tasksBase` which
  // resolves to `<TASKS_BASE>/<safeTicketPath(ticket)>`. Reject if the
  // ticket arg we received doesn't match the token's tasksBase — that means
  // a parallel session clobbered us and we should bail rather than write
  // evidence under the wrong ticket. The caller (task-next.js) will retry.
  if (expectedTicketId && typeof token.tasksBase === 'string' && token.tasksBase.length > 0) {
    const safe = sanitizeId(expectedTicketId);
    const expectedSegment = `${path.sep}${safe}${path.sep}`;
    const expectedSuffix = `${path.sep}${safe}`;
    if (!token.tasksBase.includes(expectedSegment) && !token.tasksBase.endsWith(expectedSuffix)) {
      errorExit(
        `Write token belongs to a different ticket (token.tasksBase=${token.tasksBase}, expected ticket=${expectedTicketId}). ` +
          'Likely cause: parallel session for another ticket overwrote /tmp/.claude-write-tokens/' +
          `${scriptBasename} between the hook's mint and this consume. Re-invoke task-next.js to mint a fresh token.`
      );
    }
  }
}

// ─── Subcommands ────────────────────────────────────────────────────────────

function cmdInit(ticketId, args) {
  if (!ticketId) {
    errorExit('Missing ticket ID. Usage: node tdd-phase-state.js init <TICKET_ID>');
  }
  const taskNum = safeParseTask(args || []);
  const opts = taskNum ? { taskNum } : undefined;
  const state = {
    currentPhase: 'red',
    currentCycle: 1,
    cycles: [],
  };
  writeState(ticketId, state, opts);
  successOut({ ok: true, phase: 'red', cycle: 1 });
}

function cmdCurrent(ticketId, args) {
  if (!ticketId) {
    errorExit('Missing ticket ID.');
  }
  const taskNum = safeParseTask(args || []);
  const opts = taskNum ? { taskNum } : undefined;
  const state = readState(ticketId, opts);
  if (!state) {
    errorExit('No TDD phase state found. Run "init" first.');
  }
  successOut({ phase: state.currentPhase, cycle: state.currentCycle });
}

function cmdRecordRed(ticketId, args) {
  if (!ticketId) errorExit('Missing ticket ID.');
  const cmd = parseCmd(args);
  if (!cmd) errorExit('Missing --cmd argument.');
  const taskNum = safeParseTask(args);
  const opts = taskNum ? { taskNum } : undefined;

  // Spec §P0#4 — synthesized-cycle bypass. When `--synthesized` is set and a
  // non-empty `--reason` is supplied, a passing `--cmd` is accepted as
  // RED-equivalent evidence (e.g. regression backfill where the failing test
  // pre-exists). Empty/missing reason is fail-closed with a `BYPASS:` line and
  // no audit row appended. See `feedback_no_fake_tdd_evidence.md` — the bypass
  // requires explicit justification persisted to .work-actions.json so any use
  // is auditable.
  const synthesized = args.includes('--synthesized');
  if (synthesized) {
    return cmdRecordRedSynthesized(ticketId, args, cmd, taskNum, opts);
  }

  const state = readState(ticketId, opts); // reads per-task path when taskNum provided
  if (!state) errorExit('No TDD phase state found. Run "init" first.');
  // Enforce phase consistency: record-red only allowed during red phase
  if (state.currentPhase !== 'red')
    errorExit(
      'Cannot record RED evidence: current phase is "' +
        state.currentPhase +
        '". Transition to red first.'
    );

  // Detect changed test files via git diff
  let allChanged = [];
  try {
    const diff = execSync('git diff --name-only', { encoding: 'utf8' }).trim();
    const staged = execSync('git diff --cached --name-only', { encoding: 'utf8' }).trim();
    const untracked = execSync('git ls-files --others --exclude-standard', {
      encoding: 'utf8',
    }).trim();
    allChanged = [
      ...new Set(
        [...diff.split('\n'), ...staged.split('\n'), ...untracked.split('\n')].filter(Boolean)
      ),
    ];
  } catch {
    // git not available or not a repo
  }
  const testFiles = allChanged.filter((f) => isTestFile(f));

  if (testFiles.length === 0) {
    errorExit('No test files changed. RED phase requires modified .test or .spec files.');
  }

  // Run tests — they must FAIL
  const { exitCode, stdout, stderr } = runTestCommandWithOutput(cmd);
  if (exitCode === 0) {
    errorExit('Tests must FAIL in RED phase. Tests passed (exit 0).');
  }

  // GH-532: reject fake-RED caused by load failures (ReferenceError /
  // SyntaxError / Cannot find module / 0 tests reported). These exit
  // non-zero but the test file never actually ran an assertion.
  // Scan stdout and stderr independently — concatenating them can leak
  // an unclosed YAML-envelope state across the seam when stdout is
  // truncated (timeout / signal) and mask a real stderr load failure.
  const loadFailure = detectRedLoadFailure({ stdout, stderr });
  if (loadFailure.matched) {
    rejectRedLoadFailure({
      ticketId,
      cycle: state.currentCycle,
      testCommand: cmd,
      signature: loadFailure.signature,
      snippet: extractLoadFailureSnippet(loadFailure.line),
      taskNum,
    });
  }

  // Record evidence
  const record = getCurrentCycleRecord(state);
  record.red = {
    testFiles,
    testCommand: cmd,
    testExitCode: exitCode,
    timestamp: new Date().toISOString(),
  };
  writeState(ticketId, state, opts);
  successOut({
    ok: true,
    phase: 'red',
    cycle: state.currentCycle,
    testFiles,
    testExitCode: exitCode,
  });
}

/**
 * Handle `record-red --synthesized --reason "<...>"` (spec §P0#4).
 *
 * Contract:
 *   - `--reason` must be present and non-empty (else exit non-zero with `BYPASS:`
 *     line; no audit row appended — fail-closed on missing justification).
 *   - Supplied `--cmd` is executed; if it exits 0, the cycle's red evidence is
 *     persisted with `synthesized: true` + `reason`, and the phase transitions
 *     RED → GREEN.
 *   - Exactly one `tdd-synthesized-cycle` audit row is appended via
 *     `appendEnforcementAudit` (the sole audit writer — see R11).
 *
 * Mirrors the structure of `cmdException` / `auditException` so the two bypass
 * paths share auditing semantics.
 */
function cmdRecordRedSynthesized(ticketId, args, cmd, taskNum, opts) {
  // Validate reason (mirrors cmdException). Empty/missing → BYPASS, no audit.
  const reasonIdx = args.indexOf('--reason');
  const reason = reasonIdx !== -1 && reasonIdx + 1 < args.length ? args[reasonIdx + 1] : undefined;
  if (!reason || !reason.trim()) {
    // Write a BYPASS: line to stderr so callers see the recovery hint. Do NOT
    // append an audit row — fail-closed: no justification ⇒ no record.
    process.stderr.write(
      'BYPASS: tdd-phase-state.js record-red --synthesized --reason "<why this cycle is synthesized>"\n'
    );
    process.exit(1);
  }

  const state = readState(ticketId, opts);
  if (!state) errorExit('No TDD phase state found. Run "init" first.');
  if (state.currentPhase !== 'red') {
    errorExit(
      'Cannot record RED evidence: current phase is "' +
        state.currentPhase +
        '". Transition to red first.'
    );
  }

  // Run the supplied --cmd. The bypass requires a *passing* command (exit 0):
  // this is the whole point — the agent claims the failing test already
  // exists/is covered, so re-running it must pass.
  const exitCode = runTestCommand(cmd);
  if (exitCode !== 0) {
    errorExit(
      '--synthesized requires the supplied --cmd to exit 0 (the pre-existing test should pass). ' +
        'Command exited ' +
        exitCode +
        '.'
    );
  }

  // Detect any test-file changes (informational; not required for bypass).
  let allChanged = [];
  try {
    const diff = execSync('git diff --name-only', { encoding: 'utf8' }).trim();
    const staged = execSync('git diff --cached --name-only', { encoding: 'utf8' }).trim();
    const untracked = execSync('git ls-files --others --exclude-standard', {
      encoding: 'utf8',
    }).trim();
    allChanged = [
      ...new Set(
        [...diff.split('\n'), ...staged.split('\n'), ...untracked.split('\n')].filter(Boolean)
      ),
    ];
  } catch {
    /* git not available */
  }
  const testFiles = allChanged.filter((f) => isTestFile(f));

  const record = getCurrentCycleRecord(state);
  record.red = {
    testFiles,
    testCommand: cmd,
    testExitCode: exitCode,
    synthesized: true,
    reason: reason,
    timestamp: new Date().toISOString(),
  };

  // Transition RED → GREEN as part of the bypass — the synthesized cycle is
  // accepted immediately so the next task-next.js invocation runs the GREEN
  // command (R12 integration scenario).
  state.currentPhase = 'green';
  writeState(ticketId, state, opts);

  // Append the audit row via the canonical writer (R11: appendEnforcementAudit
  // is the sole audit path; .work-actions.json is append-only).
  try {
    const { appendEnforcementAudit } = require('../work/lib/work-actions');
    appendEnforcementAudit(ticketId, {
      origin: 'ai-subtask',
      task: taskNum || null,
      phase: 'red',
      action: 'tdd-synthesized-cycle',
      allow: true,
      reason: reason,
      outputPath: null,
      meta: { cycle: state.currentCycle, testCommand: cmd },
    });
  } catch {
    /* fail-open on audit write — the state transition is the source of truth */
  }

  successOut({
    ok: true,
    phase: 'green',
    cycle: state.currentCycle,
    synthesized: true,
    reason,
    testExitCode: exitCode,
  });
}

function cmdRecordGreen(ticketId, args) {
  if (!ticketId) errorExit('Missing ticket ID.');
  const cmd = parseCmd(args);
  if (!cmd) errorExit('Missing --cmd argument.');
  const taskNum = safeParseTask(args);
  const opts = taskNum ? { taskNum } : undefined;

  const state = readState(ticketId, opts);
  if (!state) errorExit('No TDD phase state found. Run "init" first.');
  // Enforce phase consistency: record-green only allowed during green phase
  if (state.currentPhase !== 'green')
    errorExit(
      'Cannot record GREEN evidence: current phase is "' +
        state.currentPhase +
        '". Transition to green first.'
    );

  const { exitCode, stdout, stderr } = runTestCommandWithOutput(cmd);
  if (exitCode !== 0) {
    errorExit('Tests must PASS in GREEN phase. Tests failed (exit ' + exitCode + ').');
  }

  // RC-D defense: refuse the "empty command exits 0" trap. A wrapped command
  // like `eval "$TEST_UNIT_COMMAND"` with `$TEST_UNIT_COMMAND` unbound expands
  // to `eval ""` and exits 0 silently. The wedge that follows (false GREEN →
  // task advanced → next task scope blocks edits to the still-unwritten source)
  // was observed on GH-417 / GH-432 / GH-452 — agents could not recover via
  // /work. Real test runners always emit something to stdout or stderr; if
  // both are empty AND exit was 0, the command did no work. Refuse to record.
  if (stdout.trim() === '' && stderr.trim() === '') {
    errorExit(
      'GREEN test command exited 0 with NO stdout/stderr output. This is the ' +
        'empty-command trap (typically an unbound test-command env var expanded ' +
        'to `eval ""`). Real test runs always emit output. Source the worktree' +
        "'s .envrc so $TEST_UNIT_COMMAND / $TEST_INTEGRATION_COMMAND are bound, " +
        'verify the command runs real tests, then retry.'
    );
  }

  // RC-B defense: reject all-skipped false positives. A spec where every test
  // is .skip exits 0 but delivers zero coverage. Recording that as GREEN lets
  // the workflow advance with no work shipped (ECHO-4451 hit this).
  const summary = parseTestSummary(stdout + '\n' + stderr);
  if (summary.parsed && summary.passed === 0 && summary.skipped > 0) {
    errorExit(
      'All tests are skipped (' +
        summary.skipped +
        ' skipped, 0 passed). GREEN requires actual passing tests, not skipped. ' +
        "Unskip the affected tests in this PR's scope, or document the skips with " +
        'their follow-up tickets in tasks.md before re-invoking me.'
    );
  }

  const record = getCurrentCycleRecord(state);
  record.green = {
    testCommand: cmd,
    testExitCode: exitCode,
    timestamp: new Date().toISOString(),
  };
  writeState(ticketId, state, opts);
  successOut({ ok: true, phase: 'green', cycle: state.currentCycle, testExitCode: exitCode });
}

// cmdRecordRefactor: records re-run evidence only; does NOT invoke
// /tests-review or /code-review. Those reviewer commands run as a separate
// post-commit gate owned by workflows/work/steps/task-review.js (GH-211),
// not by this CLI and not by the developer agent driving the TDD loop.
function cmdRecordRefactor(ticketId, args) {
  if (!ticketId) errorExit('Missing ticket ID.');
  const cmd = parseCmd(args);
  if (!cmd) errorExit('Missing --cmd argument.');
  const taskNum = safeParseTask(args);
  const opts = taskNum ? { taskNum } : undefined;

  const state = readState(ticketId, opts);
  if (!state) errorExit('No TDD phase state found. Run "init" first.');
  // Enforce phase consistency: record-refactor only allowed during refactor phase
  if (state.currentPhase !== 'refactor')
    errorExit(
      'Cannot record REFACTOR evidence: current phase is "' +
        state.currentPhase +
        '". Transition to refactor first.'
    );

  const { exitCode, stdout, stderr } = runTestCommandWithOutput(cmd);
  if (exitCode !== 0) {
    errorExit('Tests must still PASS after refactoring. Tests failed (exit ' + exitCode + ').');
  }

  // RC-D defense: same empty-command guard as GREEN. Refuse exit-0-with-no-output.
  if (stdout.trim() === '' && stderr.trim() === '') {
    errorExit(
      'REFACTOR test command exited 0 with NO stdout/stderr output. This is the ' +
        'empty-command trap (typically an unbound test-command env var expanded ' +
        'to `eval ""`). Real test runs always emit output. Source the worktree' +
        "'s .envrc so test-command env vars are bound, verify the command runs " +
        'real tests, then retry.'
    );
  }

  // RC-B defense: same all-skipped guard as GREEN — REFACTOR also delivers
  // zero coverage when every test is .skip.
  const summary = parseTestSummary(stdout + '\n' + stderr);
  if (summary.parsed && summary.passed === 0 && summary.skipped > 0) {
    errorExit(
      'All tests are skipped (' +
        summary.skipped +
        ' skipped, 0 passed). REFACTOR requires actual passing tests, not skipped. ' +
        "Unskip the affected tests in this PR's scope, or document the skips with " +
        'their follow-up tickets in tasks.md before re-invoking me.'
    );
  }

  const record = getCurrentCycleRecord(state);
  record.refactor = {
    testCommand: cmd,
    testExitCode: exitCode,
    timestamp: new Date().toISOString(),
  };
  writeState(ticketId, state, opts);
  successOut({ ok: true, phase: 'refactor', cycle: state.currentCycle, testExitCode: exitCode });
}

function cmdTransition(ticketId, targetPhase, args) {
  if (!ticketId) errorExit('Missing ticket ID.');
  if (!targetPhase) errorExit('Missing target phase.');
  const taskNum = safeParseTask(args || []);
  const opts = taskNum ? { taskNum } : undefined;

  const state = readState(ticketId, opts);
  if (!state) errorExit('No TDD phase state found. Run "init" first.');

  // Validate transition
  if (!tddCanTransition(state.currentPhase, targetPhase)) {
    errorExit(
      `Invalid transition: ${state.currentPhase} -> ${targetPhase}. ` +
        `Valid transitions: red->green, green->refactor, green->red, refactor->red.`
    );
  }

  // Validate evidence exists for current phase
  const currentCycleRecord = state.cycles.find((c) => c.cycle === state.currentCycle);
  if (!currentCycleRecord || !currentCycleRecord[state.currentPhase]) {
    errorExit(
      `No evidence recorded for ${state.currentPhase} phase. ` +
        `Run "record-${state.currentPhase}" first.`
    );
  }

  // Update phase
  state.currentPhase = targetPhase;

  // If transitioning refactor -> red, increment cycle
  if (targetPhase === 'red') {
    state.currentCycle += 1;
  }

  writeState(ticketId, state, opts);
  successOut({ phase: state.currentPhase, cycle: state.currentCycle });
}

function auditException(ticketId, taskNum, category, reason, allow) {
  try {
    const { appendEnforcementAudit } = require('../work/lib/work-actions');
    appendEnforcementAudit(ticketId, {
      origin: 'ai-subtask',
      task: taskNum || null,
      phase: null,
      action: 'tdd-exception',
      allow,
      reason: (category || 'unknown') + ': ' + (reason || ''),
      outputPath: null,
      meta: { category },
    });
  } catch {
    /* fail-open */
  }
}

function cmdException(ticketId, args) {
  if (!ticketId) errorExit('Missing ticket ID.');

  // Parse --category (required)
  const category = parseCategory(args);
  const taskNum = safeParseTask(args);
  if (!category) {
    auditException(ticketId, taskNum, null, null, false);
    errorExit(
      'Missing --category argument. Usage: node tdd-phase-state.js exception <TICKET_ID> --category <category> --reason "<reason>"'
    );
  }

  // Validate category
  const { validateExceptionCategory, checkNewExportedCode } = require('./exception-validator');
  const catResult = validateExceptionCategory(category);
  if (!catResult.valid) {
    auditException(ticketId, taskNum, category, null, false);
    errorExit('Invalid exception category: ' + catResult.reason);
  }

  // Validate checkpoint category against actual task metadata
  if (category === 'checkpoint') {
    if (!taskNum) {
      auditException(ticketId, null, category, null, false);
      errorExit(
        'Category "checkpoint" requires --task <N> to identify which task is a checkpoint.'
      );
    }
    const { isCheckpointTask } = require('./exception-validator');
    const resolvedTasksBase = resolveTasksBaseWithFallback();
    const safeId = sanitizeId(ticketId);
    if (!isCheckpointTask(safeId, taskNum, resolvedTasksBase)) {
      auditException(ticketId, taskNum, category, null, false);
      errorExit(
        'Category "checkpoint" is only allowed for checkpoint tasks. Task ' +
          taskNum +
          ' is not a checkpoint task.'
      );
    }
  }

  // Parse --reason (required)
  const reasonIdx = args.indexOf('--reason');
  if (reasonIdx === -1 || reasonIdx + 1 >= args.length) {
    auditException(ticketId, taskNum, category, null, false);
    errorExit('Missing --reason argument.');
  }
  const reason = args[reasonIdx + 1];
  if (!reason || !reason.trim()) {
    auditException(ticketId, taskNum, category, '', false);
    errorExit('Reason cannot be empty.');
  }

  const opts = taskNum ? { taskNum } : undefined;

  // Heuristic check: detect new exported code (skip for checkpoint and file-move)
  if (category !== 'checkpoint' && category !== 'file-move') {
    let allChanged = [];
    try {
      const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
      const gitOpts = { encoding: 'utf8', cwd: repoRoot };
      const diff = execSync('git diff --diff-filter=A --name-only', gitOpts).trim();
      const staged = execSync('git diff --cached --diff-filter=A --name-only', gitOpts).trim();
      const untracked = execSync('git ls-files --others --exclude-standard', gitOpts).trim();
      const relFiles = [
        ...new Set(
          [...diff.split('\n'), ...staged.split('\n'), ...untracked.split('\n')].filter(Boolean)
        ),
      ];
      allChanged = relFiles.map((f) => path.resolve(repoRoot, f));
    } catch {
      auditException(ticketId, taskNum, category, reason, false);
      errorExit(
        'Unable to verify exception eligibility: git repository detection failed. Run this command from within the repository so new-export checks can be enforced.'
      );
    }

    const exportCheck = checkNewExportedCode(allChanged);
    if (exportCheck.hasNewExports) {
      auditException(ticketId, taskNum, category, reason, false);
      errorExit(
        'New exported code detected in: ' +
          exportCheck.files.join(', ') +
          '. TDD is required for new code with exports. Use the RED-GREEN-REFACTOR cycle instead of exception mode.'
      );
    }
  }

  // Write structured exception
  const state = {
    currentPhase: 'exception',
    exception: { category, reason },
    cycles: [],
  };
  writeState(ticketId, state, opts);

  auditException(ticketId, taskNum, category, reason, true);

  successOut({ ok: true, phase: 'exception', category, reason });
}

// ─── Main ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const subcommand = args[0];
const ticketId = args[1];

// Token gating: enforce-step-workflow.js Rule 5 issues tokens via AGENT_GATED_SCRIPTS
// where tdd-phase-state.js is registered with developer-* agents authorized.
// WORK_TDD_TOKEN_SKIP=1 bypasses verification for standalone/debugging use.
if (GATED_SUBCOMMANDS.includes(subcommand) && process.env.WORK_TDD_TOKEN_SKIP !== '1') {
  verifyToken(ticketId);
}

switch (subcommand) {
  case 'init':
    cmdInit(ticketId, args.slice(2));
    break;
  case 'current':
    cmdCurrent(ticketId, args.slice(2));
    break;
  case 'record-red':
    cmdRecordRed(ticketId, args.slice(2));
    break;
  case 'record-green':
    cmdRecordGreen(ticketId, args.slice(2));
    break;
  case 'record-refactor':
    cmdRecordRefactor(ticketId, args.slice(2));
    break;
  case 'transition':
    cmdTransition(ticketId, args[2], args.slice(2));
    break;
  case 'exception':
    cmdException(ticketId, args.slice(2));
    break;
  default:
    errorExit(
      `Unknown subcommand: ${subcommand}. ` +
        'Valid: init, current, record-red, record-green, record-refactor, transition, exception'
    );
}
