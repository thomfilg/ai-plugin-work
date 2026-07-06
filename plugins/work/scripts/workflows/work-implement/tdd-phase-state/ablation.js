'use strict';

/**
 * tdd-phase-state/ablation.js
 *
 * GH-570 — ablation-RED mode for regression-coverage tasks.
 *
 * Tasks that pin already-working behavior have no natural failing RED: the
 * new test passes immediately. Instead of the free-text `--synthesized`
 * bypass (deprecated — it accepts a passing run with no machine-checkable
 * claim), the planner declares `red-mode: ablation` in the task's
 * `### Test Strategy` block at authoring time (human-reviewed at the tasks
 * gate — NOT grantable at execution time). The cycle then runs as:
 *
 *   RED:   the agent applies a TEMPORARY source mutation that breaks the
 *          behavior under test. The recorder requires a non-empty tracked
 *          SOURCE diff (test-file-only changes do not count) with at least
 *          one mutated file inside the task's `### Files in scope`, requires
 *          in-scope test files with it()/test() blocks on disk (the pinning
 *          tests the cycle exists to prove), hashes the mutation diff
 *          (`mutationSha`) AND the in-scope test files' content
 *          (`testFileStateSha`), and requires the command to FAIL.
 *   GREEN: the agent reverts the mutation. The recorder requires the
 *          command to PASS, verifies the mutation diff is GONE (the current
 *          source-diff hash must differ from `mutationSha`), and requires
 *          the in-scope test files to be BYTE-IDENTICAL to their RED state
 *          (so the fail→pass flip is attributable to the reverted source
 *          mutation, not to a test edit). Then stamps `revertSha` (HEAD,
 *          falling back to the current diff hash).
 *   Audit: one `tdd-ablation-cycle` row carrying BOTH shas (non-optional)
 *          so a reviewer can replay the cycle.
 *
 * Every check is machine-verified from git / on-disk tasks.md — nothing
 * here trusts agent-supplied free text (SHA-gated-enforcement precedent).
 */

const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { isTestFile } = require('../tdd-phase-registry');
const { resolveActiveTaskStrategy } = require('./strategy');
const { getCurrentCycleRecord, errorExit, successOut } = require('./io');
const { writeState } = require('./state-path');
const { requireState, assertRecordPhase, detectChangedTestFiles } = require('./record-helpers');
const { readActiveTaskBlock } = require('./active-task');
// Shared scope matcher (validator-unification rule — same implementation the
// resume-completed recorder and the work-implement-enforce hook use).
const { fileInTaskScope } = require('../../lib/task-scope');
// GH-570 integrity helpers: test-file content pinning + failingTest parsing.
const {
  scopeTestFiles,
  computeTestFileStateSha,
  extractFailingTestNames,
} = require('./ablation-pinning');
// Shared RED guard sequence (GH-584 hang + GH-532 load-failure rejections).
const { runGuardedRedCommand } = require('./red-guards');

const ABLATION_RED_MODE = 'ablation';

const ABLATION_NO_MUTATION_MSG =
  'Rejected ablation RED: no source mutation detected in the working tree. ' +
  'This task declares `red-mode: ablation` — RED evidence is produced by ' +
  'TEMPORARILY mutating tracked source (non-test) files so the behavior ' +
  'under test breaks. Apply the mutation (do NOT commit it), confirm the ' +
  'test command fails, then re-run record-red. Test-file-only changes do ' +
  'not count as a mutation.';

const ABLATION_RED_PASSED_MSG =
  'Rejected ablation RED: the test command exited 0 with the source ' +
  'mutation applied. The mutation must BREAK the behavior under test so ' +
  'the command fails — a mutation the test does not detect proves the test ' +
  'asserts nothing. Strengthen the mutation (or the test), then re-run ' +
  'record-red.';

const ABLATION_MUTATION_OUT_OF_SCOPE_MSG =
  "Rejected ablation RED: no mutated source file is inside this task's " +
  '`### Files in scope`. The ablation mutation must break the behavior THIS ' +
  'task pins — a diff in an unrelated tracked file (e.g. a README edit) ' +
  'proves nothing about the pinning tests. Mutate an in-scope source file, ' +
  'confirm the test command fails, then re-run record-red.';

const ABLATION_NO_TEST_BLOCKS_MSG =
  'Rejected ablation RED: no in-scope *.test.* / *.spec.* file on disk ' +
  'contains it()/test() blocks. Ablation cycles exist to prove PINNING ' +
  'tests detect a source mutation — author the pinning test(s) under the ' +
  "task's `### Files in scope` first, then apply the mutation and re-run " +
  'record-red.';

const ABLATION_TEST_DRIFT_MSG =
  'Rejected ablation GREEN: the in-scope test files are not byte-identical ' +
  'to their RED-phase state (testFileStateSha mismatch). The fail→pass flip ' +
  'must be attributable to the reverted source mutation alone — editing the ' +
  'tests between RED and GREEN voids the cycle. Restore the RED-phase test ' +
  'files (or re-record RED with the current tests), then re-run record-green.';

// GH-570 — `--synthesized` deprecation notice (stderr, never stdout — the
// success payload is machine-read JSON). The mechanism keeps working for
// existing callers during the migration window.
const SYNTHESIZED_DEPRECATION_WARNING =
  'DEPRECATION (GH-570): record-red --synthesized is deprecated. It accepts ' +
  'a passing run with only a free-text reason — no machine-checkable claim. ' +
  'For regression-coverage tasks, declare `red-mode: ablation` in the ' +
  "task's `### Test Strategy` block at planning time and record an " +
  'ablation cycle instead (source mutation → failing RED; revert → GREEN).\n';

function _git(args, cwd) {
  const r = spawnSync('git', args, {
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return r.status === 0 ? (r.stdout || '').trim() : null;
}

/**
 * Read the planner-declared `red-mode:` for a task from on-disk tasks.md.
 * Returns `'ablation'` or `null`. Fail-open to `null` — a missing/unreadable
 * strategy simply means the task is not an ablation task.
 */
function declaredRedMode(ticketId, taskNum) {
  const resolved = resolveActiveTaskStrategy(ticketId, taskNum);
  const mode = resolved && resolved.strategy && resolved.strategy.redMode;
  return mode === ABLATION_RED_MODE ? ABLATION_RED_MODE : null;
}

/**
 * GH-570 — resolve the effective RED mode for this invocation.
 *
 * The ONLY authorization source is the planner-authored `red-mode: ablation`
 * line in tasks.md (reviewed at the tasks gate). The `--ablation` CLI flag is
 * a request, never a grant: passing it without the declaration rejects, and
 * omitting it on a declared task still routes to the ablation path (the
 * execution contract is authoring-time-declared, not de-grantable either).
 */
function resolveAblationRedMode(ticketId, taskNum, args) {
  const declared = declaredRedMode(ticketId, taskNum);
  const requested = Array.isArray(args) && args.includes('--ablation');
  if (requested && declared !== ABLATION_RED_MODE) {
    errorExit(
      "--ablation requires `red-mode: ablation` declared in this task's " +
        '`### Test Strategy` block in tasks.md. ' +
        `Task ${taskNum || '?'} has no such declaration — ablation mode is ` +
        'planner-authored at the tasks gate and NOT grantable at execution ' +
        'time. Record a real failing RED instead.'
    );
  }
  if (declared === ABLATION_RED_MODE && args.includes('--synthesized')) {
    errorExit(
      'This task declares `red-mode: ablation` in tasks.md — the deprecated ' +
        '--synthesized bypass is not allowed for it. Record the ablation ' +
        'cycle instead: apply a temporary source mutation that makes the ' +
        'test command fail, then run record-red (no extra flags needed).'
    );
  }
  return declared;
}

/**
 * Detect the working-tree source mutation: tracked files changed vs HEAD
 * (staged + unstaged), excluding test files. Returns
 * `{ sourceFiles, mutationSha }` where `mutationSha` is the sha256 hex of
 * the source-restricted diff, or `null` when no source file is modified.
 * Untracked files never count — an ablation breaks EXISTING behavior, which
 * lives in tracked source.
 */
function computeSourceMutation(cwd) {
  const names = _git(['diff', 'HEAD', '--name-only'], cwd);
  if (names == null) return { sourceFiles: [], mutationSha: null };
  const sourceFiles = names
    .split('\n')
    .filter(Boolean)
    .filter((f) => !isTestFile(f));
  if (sourceFiles.length === 0) return { sourceFiles: [], mutationSha: null };
  const diff = _git(['diff', 'HEAD', '--', ...sourceFiles], cwd);
  if (!diff) return { sourceFiles: [], mutationSha: null };
  const mutationSha = crypto.createHash('sha256').update(diff).digest('hex');
  return { sourceFiles, mutationSha };
}

/** Repo root from git (cwd fallback) — the recorder runs inside the worktree. */
function _repoRoot(cwd) {
  return _git(['rev-parse', '--show-toplevel'], cwd) || cwd || process.cwd();
}

/**
 * Resolve the GREEN-side `revertSha`: HEAD commit sha, falling back to the
 * sha256 of the current source diff when HEAD is unresolvable. Returns null
 * only when both probes fail (caller must reject — the audit row's shas are
 * non-optional).
 */
function resolveRevertSha(cwd) {
  const head = _git(['rev-parse', 'HEAD'], cwd);
  if (head) return head;
  const current = computeSourceMutation(cwd);
  return current.mutationSha || null;
}

/**
 * Append the `tdd-ablation-cycle` audit row. Both shas are REQUIRED by the
 * GH-570 contract — callers must have resolved them before recording green.
 * The append itself is best-effort (established audit-writer convention);
 * the evidence write is the source of truth.
 */
function appendAblationAudit(ticketId, { taskNum, cycle, testCommand, mutationSha, revertSha }) {
  try {
    const { appendEnforcementAudit } = require('../../work/lib/work-actions');
    appendEnforcementAudit(ticketId, {
      origin: 'ai-subtask',
      task: taskNum || null,
      phase: 'green',
      action: 'tdd-ablation-cycle',
      allow: true,
      reason: 'ablation-RED cycle completed (mutation applied → command failed; reverted → passed)',
      outputPath: null,
      meta: { cycle, testCommand, mutationSha, revertSha },
    });
  } catch {
    /* fail-open on audit write — the recorded evidence is the source of truth */
  }
}

/**
 * Ablation-RED recording (GH-570). Preconditions enforced by the caller
 * (record-red.js): the task declares `red-mode: ablation` in tasks.md.
 * Requires the mutation to touch the task's `### Files in scope` and the
 * in-scope pinning tests to exist (it()/test() blocks on disk — mirrors
 * resume-completed condition b), pins the test files' content
 * (`testFileStateSha`, verified byte-identical at GREEN), then runs the
 * shared RED guard sequence (hang / passed / load-failure rejections —
 * GH-584 + GH-532) with the ablation-specific "command exited 0"
 * diagnostic and records the ablation evidence (including best-effort
 * `failingTest` names parsed from the runner output).
 */
function cmdRecordRedAblation({ ticketId, cmd, taskNum, opts }) {
  const state = requireState(ticketId, opts);
  assertRecordPhase(state, 'red', 'RED', 'red');

  const mutation = computeSourceMutation();
  if (!mutation.mutationSha) errorExit(ABLATION_NO_MUTATION_MSG);

  const repoRoot = _repoRoot();
  const { scope } = readActiveTaskBlock(ticketId, taskNum);
  // The mutation must break behavior THIS task pins — an out-of-scope diff
  // (README churn) proves nothing about the pinning tests.
  if (!mutation.sourceFiles.some((f) => fileInTaskScope(f, scope))) {
    errorExit(ABLATION_MUTATION_OUT_OF_SCOPE_MSG);
  }
  // The pinning tests must exist on disk with real it()/test() blocks.
  if (scopeTestFiles(repoRoot, scope).totalBlocks === 0) {
    errorExit(ABLATION_NO_TEST_BLOCKS_MSG);
  }
  const testFileState = computeTestFileStateSha(repoRoot, scope);

  const run = runGuardedRedCommand({
    ticketId,
    cmd,
    taskNum,
    state,
    passedMsg: ABLATION_RED_PASSED_MSG,
  });

  const record = getCurrentCycleRecord(state);
  record.red = {
    testFiles: detectChangedTestFiles(),
    testCommand: cmd,
    testExitCode: run.exitCode,
    failingTest: extractFailingTestNames(`${run.stdout}\n${run.stderr}`),
    ablation: true,
    mutationSha: mutation.mutationSha,
    mutatedFiles: mutation.sourceFiles,
    testFileStateSha: testFileState.sha,
    pinnedTestFiles: testFileState.files,
    timestamp: new Date().toISOString(),
  };
  writeState(ticketId, state, opts);
  successOut({
    ok: true,
    phase: 'red',
    cycle: state.currentCycle,
    ablation: true,
    mutationSha: mutation.mutationSha,
    testExitCode: run.exitCode,
  });
}

/**
 * Ablation-GREEN recording (GH-570). Called by record-cycle.js's
 * cmdRecordGreen AFTER the standard GREEN guards (pass required, hang
 * rejected, RC-D empty-output trap, RC-B all-skipped trap) when the current
 * cycle's RED evidence carries `ablation: true`. Verifies the RED-phase
 * mutation is GONE (current source-diff hash differs from `mutationSha`),
 * requires the in-scope test files to be byte-identical to their RED state
 * (`testFileStateSha` — the fail→pass flip must come from the reverted
 * source mutation, never a test edit), stamps `revertSha`, and appends the
 * `tdd-ablation-cycle` audit row with BOTH shas (non-optional per the
 * GH-570 contract).
 */
function recordAblationGreen({ ticketId, state, record, cmd, exitCode, taskNum, opts }) {
  const mutationSha = record.red && record.red.mutationSha;
  if (!mutationSha) {
    errorExit(
      'Ablation GREEN requires RED evidence carrying a mutationSha. ' +
        'Re-record RED via the ablation path (source mutation + failing run) first.'
    );
  }
  const current = computeSourceMutation();
  if (current.mutationSha === mutationSha) {
    errorExit(
      'Rejected ablation GREEN: the RED-phase source mutation is still applied ' +
        '(current source-diff hash matches mutationSha). Revert the temporary ' +
        'mutation, verify the command still passes, then re-run record-green.'
    );
  }
  // Test-file pinning: fail CLOSED when the RED record lacks the pin (it is
  // written by cmdRecordRedAblation in the same release — a red record
  // without it did not come from the ablation-RED recorder).
  const redTestSha = record.red && record.red.testFileStateSha;
  const nowTestSha = computeTestFileStateSha(
    _repoRoot(),
    readActiveTaskBlock(ticketId, taskNum).scope
  ).sha;
  if (!redTestSha || nowTestSha !== redTestSha) {
    errorExit(ABLATION_TEST_DRIFT_MSG);
  }
  const revertSha = resolveRevertSha();
  if (!revertSha) {
    errorExit(
      'Ablation GREEN could not resolve a revertSha (git HEAD unavailable and ' +
        'no diff to hash). The tdd-ablation-cycle audit row requires both shas ' +
        '— run the recorder from inside the git worktree.'
    );
  }
  record.green = {
    testCommand: cmd,
    testExitCode: exitCode,
    ablation: true,
    revertSha,
    timestamp: new Date().toISOString(),
  };
  writeState(ticketId, state, opts);
  appendAblationAudit(ticketId, {
    taskNum,
    cycle: state.currentCycle,
    testCommand: cmd,
    mutationSha,
    revertSha,
  });
  successOut({
    ok: true,
    phase: 'green',
    cycle: state.currentCycle,
    ablation: true,
    mutationSha,
    revertSha,
    testExitCode: exitCode,
  });
}

module.exports = {
  ABLATION_RED_MODE,
  SYNTHESIZED_DEPRECATION_WARNING,
  declaredRedMode,
  resolveAblationRedMode,
  computeSourceMutation,
  computeTestFileStateSha,
  extractFailingTestNames,
  resolveRevertSha,
  appendAblationAudit,
  cmdRecordRedAblation,
  recordAblationGreen,
};
