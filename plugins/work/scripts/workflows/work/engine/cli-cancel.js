/**
 * cli-cancel.js
 *
 * GH-339: the `cancel` subcommand machinery for work.workflow.js's cli.
 * Extracted from cli.js to keep the entry-point module within the static
 * quality budget (max-lines / max-lines-per-function). `runCancel` is the only
 * export; every helper here is private to the cancel flow.
 *
 * All runtime side effects (state mutation, guard release) are spawned as child
 * processes through the SANCTIONED entry points — this module never edits their
 * source and never bypasses a guard directly.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const { STEP_ORDER } = require(path.join(__dirname, '..', 'step-registry'));
const { isCancellablePhase } = require(path.join(__dirname, '..', 'work-state', 'steps'));
const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));

// Sibling child-process entry points invoked by the `cancel` subcommand.
// The mutation runs through the work-state `cancel` mutator and the guard
// release runs through the SANCTIONED session-guard `finish` teardown (reveal +
// unlink session file) — exactly as the `complete` step does. Both are spawned
// as child processes; their source files are never edited here.
const WORK_STATE_JS = path.join(__dirname, '..', 'work-state.js');
const SESSION_GUARD_JS = path.join(__dirname, '..', '..', 'lib', 'hooks', 'session-guard.js');

// GH-339: the step-ordered artifact set moved into tasks/<TICKET>/archive/ on a
// successful cancel — planning docs + enforcement/audit files.
const ARCHIVE_ARTIFACTS = [
  'brief.md',
  'spec.md',
  'tasks.md',
  '.work-actions.json',
  'tdd-phase.json',
];

/**
 * Derive the current step from a work-state: the first step flagged
 * 'in_progress', falling back to state.currentStep (1-indexed). Returns null
 * when neither yields a known step. Mirrors work-state/steps.js:currentStepOf
 * (not exported there) so cli-cancel.js can compute phaseAtCancel without
 * importing a private symbol.
 * @param {object} state
 * @returns {string|null}
 */
function phaseOfState(state) {
  const stepStatus = (state && state.stepStatus) || {};
  const inProgress = STEP_ORDER.find((step) => stepStatus[step] === 'in_progress');
  if (inProgress) return inProgress;
  const idx = Number(state && state.currentStep) - 1;
  return STEP_ORDER[idx] || null;
}

/**
 * Parse + sanitize a raw ticket argument into filesystem-safe forms, reusing
 * the same scaffold the `transition`/`transitions`/`actions` cases use
 * (parseTicketInput → uppercase base → sanitizeTicketIdForPath → append the
 * optional suffix). Throws (via parseTicketInput) on a parse failure so the
 * caller decides how to report + exit.
 * @param {string} rawTicket
 * @param {{ parseTicketInput: Function, tp: object, providerCfg: object }} args
 * @returns {{ safeBase: string, safeName: string, suffix: (string|null) }}
 */
function resolveSafeTicket(rawTicket, { parseTicketInput, tp, providerCfg }) {
  const parsed = parseTicketInput(rawTicket);
  const base = String(parsed.ticketBase).toUpperCase();
  const safeBase = tp.sanitizeTicketIdForPath(base, providerCfg);
  const safeName = safeBase + (parsed.suffix ? '/' + parsed.suffix : '');
  return { safeBase, safeName, suffix: parsed.suffix || null };
}

/**
 * GH-339: Move the planning + enforcement artifact set from `tasksDir` into
 * `tasksDir/archive/` (created + merged into if it already exists). Each source
 * path is resolved and prefix-checked to stay under tasksDir before the move.
 * Returns the resolved archive directory path.
 * @param {string} tasksDir
 * @returns {string} archive directory
 */
function archivePlanningArtifacts(tasksDir) {
  const archiveDir = path.join(tasksDir, 'archive');
  const resolvedTasksDir = path.resolve(tasksDir);
  const prefix = resolvedTasksDir.endsWith(path.sep)
    ? resolvedTasksDir
    : resolvedTasksDir + path.sep;
  fs.mkdirSync(archiveDir, { recursive: true });
  for (const name of ARCHIVE_ARTIFACTS) {
    const src = path.resolve(tasksDir, name);
    // Resolved-path prefix guard: never move anything outside the ticket dir.
    if (!src.startsWith(prefix)) continue;
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
    fs.renameSync(src, path.join(archiveDir, name));
  }
  return archiveDir;
}

// Print a `{ error, message }` JSON envelope and exit(code) (default 1).
function exitWithError(message, code = 1) {
  console.log(JSON.stringify({ error: true, message }));
  process.exit(code);
}

// True when `phase` sits at or after the `implement` step in STEP_ORDER.
function isAtOrAfterImplement(phase) {
  const implementIdx = STEP_ORDER.indexOf('implement');
  const phaseIdx = STEP_ORDER.indexOf(phase);
  return phaseIdx >= 0 && implementIdx >= 0 && phaseIdx >= implementIdx;
}

/**
 * GH-339: emit the AskUserQuestion refuse-by-default confirmation for a cancel
 * requested at/after `implement` (code has been written) and exit non-zero.
 * Never mutates or archives.
 * @param {string} safeBase
 * @param {string} phaseAtCancel
 */
function emitCancelRefusal(safeBase, phaseAtCancel) {
  console.log(
    JSON.stringify(
      {
        action: 'blocked',
        reason: `Cancel refused: code has been written (phase "${phaseAtCancel}" is at/after implement).`,
        userQuestions: [
          {
            tool: 'AskUserQuestion',
            question: `Cancel /work for ${safeBase} at "${phaseAtCancel}"? Code has already been written. This is refused by default.`,
            options: ['No — keep working (default)', 'Yes — abandon anyway'],
            default: 'No — keep working (default)',
          },
        ],
      },
      null,
      2
    )
  );
  process.exit(2);
}

/**
 * GH-339: mutate → release → archive → summary on a cancellable phase.
 *   (1) work-state `cancel` mutator (child process),
 *   (2) SANCTIONED guard `finish` teardown (child process; non-fatal),
 *   (3) archive planning + enforcement artifacts,
 *   (4) print the operator summary line + JSON response.
 * @param {{ safeBase: string, safeName: string, reason: string, phaseAtCancel: string }} p
 */
function runCancelSequence({ safeBase, safeName, reason, phaseAtCancel }) {
  // (1) Mutate state via the work-state `cancel` mutator (child process).
  try {
    execFileSync(process.execPath, [WORK_STATE_JS, 'cancel', safeName, '--reason', reason], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: 'pipe',
    });
  } catch (err) {
    const msg = err.stderr || err.stdout || err.message || String(err);
    exitWithError(`cancel mutator failed: ${msg}`);
  }

  // (2) Release the guard via the SANCTIONED `finish` teardown (reveal + unlink
  // session file). Non-fatal — no session may be active.
  try {
    execFileSync(process.execPath, [SESSION_GUARD_JS, 'finish', safeBase], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: 'pipe',
    });
  } catch {
    /* guard may be disabled / already released — non-fatal */
  }

  // (3) Archive planning + enforcement artifacts to tasks/<TICKET>/archive/.
  const tasksBase =
    getConfig('TASKS_BASE') ||
    (getConfig('WORKTREES_BASE') ? path.join(getConfig('WORKTREES_BASE'), 'tasks') : '');
  const tasksDir = path.join(tasksBase, safeName);
  const archiveLocation = archivePlanningArtifacts(tasksDir);

  // (4) Operator summary line + JSON response.
  console.log(
    `Cancelled ${safeBase} — reason: ${reason} | phase: ${phaseAtCancel} | archived to: ${archiveLocation}`
  );
  console.log(
    JSON.stringify(
      { ticket: safeBase, status: 'cancelled', reason, phaseAtCancel, archiveLocation },
      null,
      2
    )
  );
}

/**
 * GH-339: the `cancel` subcommand. Parse ticket + `--reason`, load state,
 * compute phaseAtCancel; refuse-by-default at/after implement, reject before
 * implement when past the cancel ceiling, else run the mutate→release→archive→
 * summary sequence. Exits the process on every terminal branch.
 * @param {string[]} rest — argv after the `cancel` token
 * @param {object} deps — the injected cli deps (parseTicketInput, tp, loadWorkState, requirePaths)
 */
function runCancel(rest, deps) {
  const { parseTicketInput, tp, loadWorkState, requirePaths } = deps;
  requirePaths();

  // Parse ticket via the shared scaffold. Parse failure exits 1 without mutating.
  const providerCfg = tp.getProviderConfig({ skipPrompt: true });
  let safeBase;
  let safeName;
  try {
    ({ safeBase, safeName } = resolveSafeTicket(rest[0], { parseTicketInput, tp, providerCfg }));
  } catch (e) {
    exitWithError(e.message);
  }

  // Required --reason (verbatim following argv token — no shell interp).
  const reasonIdx = rest.indexOf('--reason');
  const reason = reasonIdx === -1 ? '' : rest[reasonIdx + 1] || '';
  if (!reason) {
    exitWithError('Usage: cancel <TICKET> --reason "<reason>"');
  }

  const state = loadWorkState(safeName);
  if (!state) {
    exitWithError(`No state found for ${safeName}`);
  }
  const phaseAtCancel = phaseOfState(state);

  // Not a cancellable (planning) phase.
  if (!isCancellablePhase(phaseAtCancel)) {
    if (isAtOrAfterImplement(phaseAtCancel)) {
      // (P2 --force override is out of scope — spec §Non-goals.)
      emitCancelRefusal(safeBase, phaseAtCancel);
    }
    // Before implement but past the cancel ceiling (e.g. tasks): reject.
    exitWithError(`Cannot cancel workflow: phase "${phaseAtCancel}" is not cancellable`);
  }

  runCancelSequence({ safeBase, safeName, reason, phaseAtCancel });
}

module.exports = { runCancel };
