#!/usr/bin/env node

/**
 * enforce-review-accountability.js (PreToolUse hook)
 *
 * Blocks the follow-up-pr script from reporting "PR READY TO REVIEW"
 * unless every visible PR review comment has been accounted for in a
 * review-accountability.json file in the tasks folder.
 *
 * Each comment must have a disposition:
 *   - "addressed" — code was changed to fix it (commit SHA required)
 *   - "acknowledged" — intentionally skipped with justification shown to user
 *   - "outdated" — comment refers to code that no longer exists
 *
 * The hook fires on Bash calls that run follow-up-pr.js and checks
 * the accountability file BEFORE the script runs.
 *
 * Usage: Wire as PreToolUse hook for Bash matcher in settings.json
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { logHookError } = require(path.join(__dirname, '..', '..', 'lib', 'hook-error-log'));

const DEBUG = !!process.env.ENFORCE_HOOK_DEBUG;

process.on('uncaughtException', (err) => {
  logHookError(__filename, err);
  if (DEBUG) process.stderr.write(`[enforce-review-accountability] uncaught: ${err?.message}\n`);
  process.exit(0); // fail-open
});

/** Ticket id from the branch ref, handling both .git dirs and worktree files. */
function ticketIdFromHead() {
  const readRef = (headPath) => {
    const head = fs.readFileSync(headPath, 'utf-8').trim();
    const ref = head.startsWith('ref: ') ? head.slice(5) : head;
    const match = ref.match(/[A-Z]+-\d+|GH-\d+/i);
    return match ? match[0] : null;
  };
  try {
    return readRef(path.join('.git', 'HEAD'));
  } catch {
    /* .git is a file (worktree) — resolve gitdir below */
  }
  try {
    const dotgit = fs.readFileSync('.git', 'utf-8').trim();
    if (!dotgit.startsWith('gitdir: ')) return null;
    return readRef(path.join(path.resolve(dotgit.slice('gitdir: '.length)), 'HEAD'));
  } catch {
    return null;
  }
}

/** Number of review comments on the current PR; null when git/gh cannot answer. */
function prReviewCommentCount() {
  try {
    const pr = JSON.parse(
      execSync('gh pr view --json number', { encoding: 'utf-8', timeout: 10000 }).trim()
    );
    if (!pr.number) return null;
    const count = execSync(
      `gh api repos/{owner}/{repo}/pulls/${pr.number}/comments --jq 'length'`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();
    return parseInt(count, 10);
  } catch {
    return null; // Can't fetch PR — fail-open
  }
}

/**
 * The accountability file for a ticket, or null when no tasks root is
 * configured. TASKS_BASE is configured, never derived from WORKTREES_BASE —
 * the guess #788 refuses and #792 removed from lib/config.js. Unconfigured ⇒
 * there is no file to look for, so the caller fails open rather than judging
 * against a directory that was never located.
 */
function accountabilityFileFor(ticketId) {
  const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
  const TASKS_BASE = getConfig('TASKS_BASE');
  if (!TASKS_BASE) return null;
  let safeTicketId = ticketId;
  try {
    safeTicketId = require(path.join(__dirname, '..', '..', 'lib', 'config')).safeTicketId(
      ticketId
    );
  } catch {
    /* config unavailable — use the raw id */
  }
  return path.join(TASKS_BASE, safeTicketId, 'review-accountability.json');
}

function blockMissingFile(accountabilityFile, prComments) {
  process.stderr.write(
    `BLOCKED: PR has ${prComments} review comment(s) but no review-accountability.json found.\n` +
      `Before declaring "PR READY TO REVIEW", you must create:\n` +
      `  ${accountabilityFile}\n\n` +
      `Format: JSON array where each entry has:\n` +
      `  { "disposition": "addressed|acknowledged|outdated", "reason": "..." }\n\n` +
      `Dispositions:\n` +
      `  - "addressed" — code changed to fix it (include commit SHA in reason)\n` +
      `  - "acknowledged" — intentionally skipped (reason MUST be shown to user)\n` +
      `  - "outdated" — comment refers to code that no longer exists\n\n` +
      `Every comment visible on the PR "Files changed" tab must be accounted for.\n`
  );
  process.exit(2);
}

/** Every entry carries a disposition from the enum plus a reason. */
function assertEntriesValid(accountability) {
  for (let i = 0; i < accountability.length; i++) {
    const entry = accountability[i];
    if (!entry.disposition || !entry.reason) {
      process.stderr.write(
        `BLOCKED: review-accountability.json entry ${i} missing required fields (disposition, reason).\n`
      );
      process.exit(2);
    }
    if (!['addressed', 'acknowledged', 'outdated'].includes(entry.disposition)) {
      process.stderr.write(
        `BLOCKED: review-accountability.json entry ${i} has invalid disposition "${entry.disposition}".\n` +
          `Must be: addressed, acknowledged, or outdated.\n`
      );
      process.exit(2);
    }
  }
}

/** Parse + validate the file against the comment count; exits 2 on any failure. */
function assertAccountabilityCovers(accountabilityFile, prComments) {
  let accountability;
  try {
    accountability = JSON.parse(fs.readFileSync(accountabilityFile, 'utf-8'));
  } catch (err) {
    process.stderr.write(`BLOCKED: Failed to parse review-accountability.json: ${err.message}\n`);
    process.exit(2);
  }
  if (!Array.isArray(accountability)) {
    process.stderr.write(`BLOCKED: review-accountability.json must be a JSON array.\n`);
    process.exit(2);
  }
  if (accountability.length < prComments) {
    process.stderr.write(
      `BLOCKED: PR has ${prComments} review comment(s) but review-accountability.json only has ${accountability.length} entries.\n` +
        `Every comment must be accounted for. Missing ${prComments - accountability.length} entries.\n`
    );
    process.exit(2);
  }
  assertEntriesValid(accountability);
}

/** True for the one call this hook gates: a Bash run of follow-up-pr.js. */
function isGatedCall(hookData) {
  if ((hookData.tool_name || '') !== 'Bash') return false;
  return String(hookData.tool_input?.command || '').includes('follow-up-pr');
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) return;

  const hookData = JSON.parse(input);
  if (!isGatedCall(hookData)) return;

  const ticketId = ticketIdFromHead();
  if (!ticketId) return; // No ticket context → allow

  const prComments = prReviewCommentCount();
  if (!prComments) return; // Unknown or zero comments → allow

  const accountabilityFile = accountabilityFileFor(ticketId);
  if (!accountabilityFile) return; // No tasks root configured → fail open

  if (!fs.existsSync(accountabilityFile)) blockMissingFile(accountabilityFile, prComments);
  assertAccountabilityCovers(accountabilityFile, prComments);
}

main().catch((err) => {
  logHookError(__filename, err);
  if (DEBUG) process.stderr.write(`[enforce-review-accountability] fatal: ${err?.message}\n`);
});
