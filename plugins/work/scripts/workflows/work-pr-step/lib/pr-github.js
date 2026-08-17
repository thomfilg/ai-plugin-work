/**
 * pr-github.js — read the live PR for the current branch, for the phases that
 * need facts only GitHub has.
 *
 * The pr step is driven by the `pr-generator` agent (see
 * `work/workflow-def/agent-gated-scripts.js`), which is deliberately read-only:
 * `agents/pr-generator.md` grants `Bash, Read, Grep, Glob, WebFetch` and
 * `work-pr/agents/pr-generator/pr-generator-readonly-guard.js` blocks every
 * shell redirect, `tee`, `sed -i` and friends. So the agent cannot write
 * `pr-context.json` or `pr-body.md`, and the phases used to block forever
 * asking it to.
 *
 * The runner writes those files instead — the same thing `diff_audit` already
 * does with its changed-file snapshot. `gh pr view` is what the guard DOES
 * allow the agent to run, so nothing here needs privileges the agent lacks;
 * moving the call into the runner just puts the result somewhere the agent
 * could never have put it.
 */

'use strict';

const { execFileSync } = require('node:child_process');

const GH_TIMEOUT_MS = 15_000;

/** Run a git command in `cwd`, returning trimmed stdout or null on failure. */
function git(args, cwd) {
  try {
    const out = execFileSync('git', args, {
      encoding: 'utf8',
      timeout: GH_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Current branch name in `cwd`, or null when git can't say. */
function currentBranch(cwd) {
  return git(['branch', '--show-current'], cwd);
}

/** Current HEAD commit in `cwd`, or null when git can't say. */
function headSha(cwd) {
  return git(['rev-parse', 'HEAD'], cwd);
}

/**
 * Read the PR open for the current branch.
 *
 * The branch is passed positionally — `gh pr view` takes a positional branch
 * arg, not `--head` — so this resolves correctly from inside a worktree.
 *
 * @param {string} cwd - worktree root to run `gh` in.
 * @param {string[]} [fields] - JSON fields to request.
 * @returns {{number?: number, url?: string, body?: string, state?: string}|null}
 *   null when there is no PR, `gh` is absent, or it is not authenticated.
 */
function readPullRequest(cwd, fields = ['number', 'url', 'state']) {
  const args = ['pr', 'view'];
  const branch = currentBranch(cwd);
  if (branch) args.push(branch);
  args.push('--json', fields.join(','));
  try {
    const out = execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: GH_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    }).trim();
    if (!out) return null;
    const parsed = JSON.parse(out);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // No PR yet, no `gh`, not authenticated, bad JSON — all the same to the
    // caller: there is nothing to record, so the phase keeps waiting.
    return null;
  }
}

/**
 * Read the PR that represents the CURRENT state of this branch.
 *
 * `gh pr view <branch>` falls back to the most recent CLOSED or MERGED PR when
 * the branch has no open one. Branch reuse is a normal flow here — a merged
 * branch gets reset onto the default branch and carries follow-up work under
 * the same name — so accepting whatever `gh` returns would record a stale PR
 * number and seed `pr-body.md` with a previous change's description.
 *
 * An OPEN PR is always current. A MERGED or CLOSED one is accepted only while
 * its head commit is still this branch's HEAD: that is the PR for the work in
 * hand, merged between phases. Rejecting MERGED outright would strand a ticket
 * whose PR shipped before the runner finished its remaining phases — the same
 * trap `work/workflow-def/delivery-verifiers.js` documents.
 *
 * @param {string} cwd - worktree root to run `gh` in.
 * @param {string[]} [fields] - JSON fields to request; `state` and `headRefOid`
 *   are always included.
 * @returns {object|null} the PR, or null when there is none worth using.
 */
function readCurrentPullRequest(cwd, fields = ['number', 'url']) {
  const pr = readPullRequest(cwd, [...new Set([...fields, 'state', 'headRefOid'])]);
  return isCurrentPr(pr, cwd) ? pr : null;
}

/**
 * Does `pr` represent the current state of the branch in `cwd`?
 *
 * Split out from `readCurrentPullRequest` so a caller that must distinguish
 * "`gh` says this PR is stale" from "`gh` could not answer" can read once and
 * apply the predicate itself.
 *
 * @param {object|null} pr - a PR carrying `state` and `headRefOid`.
 * @param {string} cwd - worktree root.
 * @returns {boolean}
 */
function isCurrentPr(pr, cwd) {
  if (!pr) return false;
  if (pr.state === 'OPEN') return true;
  const head = headSha(cwd);
  return Boolean(head && pr.headRefOid && pr.headRefOid === head);
}

module.exports = {
  readPullRequest,
  readCurrentPullRequest,
  isCurrentPr,
  currentBranch,
  headSha,
  GH_TIMEOUT_MS,
};
