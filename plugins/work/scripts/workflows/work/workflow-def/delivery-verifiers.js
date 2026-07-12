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
    fs.writeFileSync(shaFile, headSha);
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
  fs.writeFileSync(shaFile, headSha);
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
 * would walk ci → cleanup → reports → complete before the user merged.
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

/** All requiredApprovals files must exist and match their approval pattern. */
function approvalsSatisfied(dir, required) {
  for (const r of required) {
    const fp = path.join(dir, r.file);
    if (!fs.existsSync(fp)) return false;
    if (!r.pattern.test(fs.readFileSync(fp, 'utf-8'))) return false;
  }
  return true;
}

/** At least one QA report must exist and every one must pass. */
function qaReportsApproved(dir, qaPattern, approvalPattern) {
  const files = fs.readdirSync(dir).filter((f) => qaPattern.test(f));
  if (files.length === 0) return false;
  return files.every((f) => approvalPattern.test(fs.readFileSync(path.join(dir, f), 'utf-8')));
}

/**
 * Reports is proven if all required check files exist and show APPROVED/COMPLETE.
 * Requirements are sourced from evidenceRequirements[reports] (declarative).
 * @param {DeliveryDeps} deps
 */
function verifyReports(deps, ticketId) {
  try {
    const dir = ticketDir(deps, ticketId);
    const reqs = deps.evidenceRequirements[deps.STEPS.reports];
    if (!approvalsSatisfied(dir, reqs?.requiredApprovals || [])) return false;
    const qaPattern = reqs?.qaReportPattern;
    const approvalPattern = reqs?.qaApprovalPattern;
    if (qaPattern && approvalPattern && !qaReportsApproved(dir, qaPattern, approvalPattern)) {
      return false;
    }
    // GH-259: When tasks.md exists, verify per-task TDD evidence
    return deps.verifyPerTaskTDD(ticketId);
  } catch {
    return false;
  }
}

/** @param {DeliveryDeps} deps */
function createDeliveryVerifiers(deps) {
  return {
    verifyCommit: (ticketId) => verifyCommit(deps, ticketId),
    verifyCheck: (ticketId) => verifyCheck(deps, ticketId),
    verifyPr: () => verifyPr(deps),
    verifyFollowUp: (ticketId) => verifyFollowUp(deps, ticketId),
    verifyCi: () => verifyCi(deps),
    verifyReports: (ticketId) => verifyReports(deps, ticketId),
  };
}

module.exports = { createDeliveryVerifiers };
