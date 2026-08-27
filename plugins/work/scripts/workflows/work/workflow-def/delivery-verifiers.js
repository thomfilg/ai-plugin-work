'use strict';

/**
 * workflow-def/delivery-verifiers.js — delivery-side step verify functions
 * for the /work workflow definition (extracted from workflow-definition.js).
 *
 * Covers the git/PR/report evidence checks: commit, check, pr, follow_up,
 * ci, reports. All verifiers are fail-closed on errors.
 *
 * Top-level functions take the shared deps bag as their first argument;
 * `createDeliveryVerifiers(deps)` binds them for the workflow definition.
 *
 * @typedef {Object} DeliveryDeps
 * @property {string} TASKS_BASE
 * @property {Function} safeTicketPath
 * @property {string} workRoot - workflows/work directory (for lib requires)
 * @property {Object} STEPS
 * @property {Object} evidenceRequirements
 * @property {Function} verifyPerTaskTDD
 */

const path = require('path');
const fs = require('fs');

const EXEC_OPTS = { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] };

function ticketDir(deps, ticketId) {
  return path.join(deps.TASKS_BASE, deps.safeTicketPath(ticketId));
}

function resolveBaseBranch(workRoot) {
  try {
    const getBaseBranch = require(path.join(workRoot, '..', 'lib', 'config')).getBaseBranch;
    return getBaseBranch({ cwd: process.cwd() });
  } catch {
    return 'origin/main'; /* fallback to origin/main */
  }
}

/**
 * 1. If saved SHA exists and HEAD differs -> new commit was made.
 * Returns true/false when the saved-SHA path decides, or null when there is
 * no saved SHA (first run) and the caller must fall through.
 */
function commitProvenBySavedSha(execFileSync, shaFile, headSha) {
  try {
    const savedSha = fs.readFileSync(shaFile, 'utf-8').trim();
    if (!savedSha || headSha === savedSha) return null;
    // Verify it's not an empty commit (must have file changes)
    const diff = execFileSync('git', ['diff', '--shortstat', savedSha, headSha], EXEC_OPTS).trim();
    if (!diff) return false; // Empty commit -- reject
    fs.writeFileSync(shaFile, headSha, { mode: 0o600 });
    return true;
  } catch {
    return null; /* no saved SHA -- first run */
  }
}

/** 2. No saved SHA -> check for any commits on branch (not on main). */
function commitProvenByBranchLog(execFileSync, baseBranch, shaFile, headSha) {
  const log = execFileSync('git', ['log', '--oneline', `${baseBranch}..HEAD`], EXEC_OPTS).trim();
  if (!log) return null;
  // Verify the merge-base (three-dot) diff vs base is non-empty — a moved
  // base cannot fabricate changes for an empty commit (GH-693).
  const diff = execFileSync(
    'git',
    ['diff', '--shortstat', `${baseBranch}...HEAD`],
    EXEC_OPTS
  ).trim();
  if (!diff) return false; // No actual changes -- reject
  fs.writeFileSync(shaFile, headSha, { mode: 0o600 });
  return true;
}

/**
 * Commit is proven only by commits ahead of the base branch (not empty
 * commits). The GH-191 branch-name fallback was DELETED (GH-693): it only
 * ran when `base..HEAD` was empty, so its sole reachable pass case was the
 * false positive — zero commits ahead with a two-dot diff fabricated by a
 * moved base. `.last-commit-sha` is now written only after commits ahead
 * are proven.
 * @param {DeliveryDeps} deps
 */
function verifyCommit(deps, ticketId) {
  try {
    const { execFileSync } = require('child_process');
    const shaFile = path.join(ticketDir(deps, ticketId), '.last-commit-sha');
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], EXEC_OPTS).trim();
    const baseBranch = resolveBaseBranch(deps.workRoot);
    let proven = commitProvenBySavedSha(execFileSync, shaFile, headSha);
    if (proven === null) {
      proven = commitProvenByBranchLog(execFileSync, baseBranch, shaFile, headSha);
    }
    if (proven === null) {
      // Zero commits ahead of the resolved base — missing work, not an
      // excuse to fall back. Repair: commit the work, or fix the base ref.
      if (process.env.ENFORCE_HOOK_DEBUG) {
        process.stderr.write(
          `[enforce-hook] commit verify: 0 commits ahead of ${baseBranch} — ` +
            `commit the work first, or repair the base ref ` +
            `(git fetch origin main / check BASE_BRANCH)\n`
        );
      }
      return false;
    }
    return proven;
  } catch {
    return false;
  }
}

/**
 * Check is proven if all required report files exist.
 * Requirements are sourced from evidenceRequirements[check] (declarative).
 * @param {DeliveryDeps} deps
 */
function verifyCheck(deps, ticketId) {
  try {
    const dir = ticketDir(deps, ticketId);
    const reqs = deps.evidenceRequirements[deps.STEPS.check];
    const required = reqs?.requiredFiles || [];
    if (!required.every((f) => fs.existsSync(path.join(dir, f)))) return false;
    // echo-6842: reports that exist but were invalidated by a loop-back or
    // HEAD drift are not evidence until /check rewrites them. Same answer the
    // check-to-PR gate gives, so the two gates cannot disagree.
    const { isEvidenceStale } = require(path.join(deps.workRoot, 'lib', 'evidence-staleness'));
    if (isEvidenceStale(dir, deps.STEPS.check)) return false;
    // At least one QA report must exist when web apps are configured
    const config = require(path.join(deps.workRoot, '..', 'lib', 'config'));
    if (config.webAppNames().length > 0) {
      const files = fs.readdirSync(dir);
      const qaPattern = reqs?.qaReportPattern;
      if (qaPattern && !files.some((f) => qaPattern.test(f))) return false;
    }
    // GH-259: When tasks.md exists, verify per-task TDD evidence
    return deps.verifyPerTaskTDD(ticketId);
  } catch {
    return false;
  }
}

/**
 * PR is proven if an open PR exists for the current branch.
 * @param {DeliveryDeps} deps
 */
function verifyPr(deps) {
  try {
    const { execFileSync } = require('child_process');
    const { buildChildEnv } = require(path.join(deps.workRoot, 'scripts', 'gh-exec'));
    const opts = {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildChildEnv(),
    };

    // Resolve branch to support worktree contexts (GH-191, GH-203)
    // Note: gh pr view uses positional branch arg, not --head flag
    let ghArgs = ['pr', 'view', '--json', 'number,state'];
    try {
      const branch = execFileSync('git', ['branch', '--show-current'], opts).trim();
      if (branch) ghArgs = ['pr', 'view', branch, '--json', 'number,state'];
    } catch {
      /* branch detection failed -- fall back to no branch arg */
    }

    const pr = JSON.parse(execFileSync('gh', ghArgs, opts).trim()); // GH-203: positional arg, not --head
    // Accept OPEN or MERGED — a merged PR is even stronger evidence
    // that the pr step succeeded than an open one. Rejecting MERGED
    // permanently strands tickets whose PR shipped before the
    // workflow finished its remaining steps.
    return pr.number > 0 && (pr.state === 'OPEN' || pr.state === 'MERGED');
  } catch {
    return false;
  }
}

/**
 * Single source of truth: delegates to follow-up-pr.js isPRGateReady()
 * which encapsulates CI, reviews, bot-comment dedup, and merge-state checks.
 * @param {DeliveryDeps} deps
 */
function verifyFollowUp(deps, ticketId) {
  try {
    const { isPRGateReady } = require(path.join(deps.workRoot, 'scripts', 'follow-up-pr.js'));
    const result = isPRGateReady();
    if (!result.ready) return false;

    // Review accountability: every PR comment must be accounted for.
    // Uses strictCommentCount (fail-closed) instead of reviews array length.
    if (result.strictCommentCount > 0) {
      const accountabilityFile = path.join(ticketDir(deps, ticketId), 'review-accountability.json');
      if (!fs.existsSync(accountabilityFile)) return false;
      const entries = JSON.parse(fs.readFileSync(accountabilityFile, 'utf-8'));
      if (!Array.isArray(entries) || entries.length < result.strictCommentCount) return false;
      // GH-285: userApproval requirement removed per brief resolution —
      // disposition + reason fields are sufficient proof of comment triage.
      const validDispositions = ['addressed', 'acknowledged', 'outdated'];
      if (!entries.every((e) => validDispositions.includes(e.disposition) && e.reason))
        return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Defense-in-depth for the third-attempt bug class (ECHO-5217/5218):
 * ci is NOT complete just because CI checks went green — the PR must
 * actually be MERGED on the remote. Without this, transition-step.js
 * would walk ci → reports → cleanup → complete before the user merged.
 * @param {DeliveryDeps} deps
 */
function verifyCi(deps) {
  try {
    const { getPRInfo, checkCI } = require(path.join(deps.workRoot, 'scripts', 'follow-up-pr.js'));
    const prInfo = getPRInfo();
    if (!prInfo || !prInfo.number) return false;
    if (checkCI(prInfo.number).status !== 'passing') return false;
    const { fetchPrState } = require(
      path.join(deps.workRoot, '..', 'work-ci', 'lib', 'phases', 'wait_merge.js')
    );
    const s = fetchPrState(process.cwd(), prInfo.number);
    return Boolean(s && s.state === 'MERGED');
  } catch {
    return false;
  }
}

/**
 * Reports is proven by the artifacts the reports step itself produces:
 * `reports.md` (shape-checked by the emit phase's OWN validator, so the gate
 * and the runner can never disagree) and `cost-report.md`.
 *
 * It used to re-assert the pre-merge CHECK evidence instead — approvals, QA
 * report statuses, per-task TDD — which was wrong twice. It never ran (reports
 * was a soft step, so stepVerifyGate skipped it), and had it run it would have
 * stranded merged tickets on evidence no post-merge action can produce. The
 * step then "completed" the moment its Bash heredoc returned, with no
 * reports.md, no learnings.md and no cost-report.md on disk and nothing
 * noticing — the observed failure this replaces.
 *
 * Checking its own output keeps the gate recoverable: the fix is to write the
 * file, which is always possible post-merge, unlike re-running a check.
 * @param {DeliveryDeps} deps
 */
function verifyReports(deps, ticketId) {
  try {
    const dir = ticketDir(deps, ticketId);
    const emit = require(path.join(deps.workRoot, '..', 'work-reports', 'lib', 'phases', 'emit'));
    if (!emit.validate({ tasksDir: dir }).ok) return false;
    return fs.existsSync(path.join(dir, 'cost-report.md'));
  } catch {
    return false;
  }
}

/**
 * The `document` step is proven by its receipt, re-checked at gate time —
 * never by a sentinel. `evaluateNotes` is the SAME evaluation `document-note.js
 * verify` runs for the agent, so the step cannot pass its own self-check and
 * then fail the transition (or the reverse).
 *
 * Fail-CLOSED on every unknown: an unreadable receipt, an unresolvable tasks
 * dir, or a throw all read as "nothing was recorded". This step sits BEFORE
 * the merge, so a false negative costs a re-run of work the agent should have
 * done anyway — where a false positive silently loses the only record of what
 * the run learned.
 *
 * @param {DeliveryDeps} deps
 */
function verifyDocument(deps, ticketId) {
  try {
    const { readNotes, evaluateNotes } = require(
      path.join(deps.workRoot, '..', 'work-document', 'lib', 'notes-store')
    );
    const { detectMemoryPlugin } = require(
      path.join(deps.workRoot, '..', 'lib', 'detect-memory-plugin')
    );
    const { resolveTicketWorktree } = require(
      path.join(deps.workRoot, '..', 'lib', 'resolve-ticket-worktree')
    );
    const dir = ticketDir(deps, ticketId);
    // A receipt invalidated by a loop-back or HEAD drift is not evidence until
    // a fresh note rewrites it — same treatment verifyCheck gives its reports,
    // and the reason `.document-notes.json` is declared in refreshedFiles.
    const { isEvidenceStale } = require(path.join(deps.workRoot, 'lib', 'evidence-staleness'));
    if (isEvidenceStale(dir, deps.STEPS.document)) return false;
    return evaluateNotes({
      notes: readNotes(dir),
      memoryConfigured: Boolean(detectMemoryPlugin()),
      worktreeRoot: resolveTicketWorktree(ticketId) || null,
      tasksDir: dir,
    }).ok;
  } catch {
    return false;
  }
}

/**
 * `ready` is proven by its own single output: the PR is no longer a draft.
 *
 * It had no verify at all and sat in softSteps, so nothing confirmed the one
 * thing the step exists to do. The cost was not a silent skip but a misleading
 * one: a still-draft PR walked on to `ci`, whose gate refuses anything not
 * MERGED — and GitHub will not merge a draft. So the run failed two steps
 * later, with "not merged", which is a correct refusal carrying a diagnosis
 * that points at the wrong step.
 *
 * `getPRInfo` did not even request `isDraft`; it does now.
 *
 * Un-softening is safe here for the same reason it was for `reports`: this
 * runs PRE-MERGE and the gate reads the step's OWN output, so a block is
 * always recoverable by doing the thing — `gh pr ready` — rather than by
 * re-running someone else's check.
 * @param {DeliveryDeps} deps
 */
function verifyReady(deps) {
  try {
    const { getPRInfo } = require(path.join(deps.workRoot, 'scripts', 'follow-up-pr.js'));
    const prInfo = getPRInfo();
    if (!prInfo || !prInfo.number) return false;
    // Fail closed on an absent field: an older gh, or a fetch that dropped it,
    // must not read as "not a draft". Only an explicit false discharges this.
    return prInfo.isDraft === false;
  } catch {
    return false;
  }
}

/** @param {DeliveryDeps} deps */
function createDeliveryVerifiers(deps) {
  return {
    verifyCommit: (ticketId) => verifyCommit(deps, ticketId),
    verifyCheck: (ticketId) => verifyCheck(deps, ticketId),
    verifyDocument: (ticketId) => verifyDocument(deps, ticketId),
    verifyPr: () => verifyPr(deps),
    verifyReady: () => verifyReady(deps),
    verifyFollowUp: (ticketId) => verifyFollowUp(deps, ticketId),
    verifyCi: () => verifyCi(deps),
    verifyReports: (ticketId) => verifyReports(deps, ticketId),
  };
}

module.exports = { createDeliveryVerifiers };
