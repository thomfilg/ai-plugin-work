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

/** Current branch name in `cwd`, or null when git can't say. */
function currentBranch(cwd) {
  try {
    const out = execFileSync('git', ['branch', '--show-current'], {
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

module.exports = { readPullRequest, currentBranch, GH_TIMEOUT_MS };
