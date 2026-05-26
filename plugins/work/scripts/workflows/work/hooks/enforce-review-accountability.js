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

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) return;

  const hookData = JSON.parse(input);
  const toolName = hookData.tool_name || '';
  const toolInput = hookData.tool_input || {};

  // Only check Bash calls that run follow-up-pr.js
  if (toolName !== 'Bash') return;
  const cmd = String(toolInput.command || '');
  if (!cmd.includes('follow-up-pr')) return;

  // Get ticket ID from branch
  let ticketId;
  try {
    const branch = fs.readFileSync(path.join('.git', 'HEAD'), 'utf-8').trim();
    const ref = branch.startsWith('ref: ') ? branch.slice(5) : branch;
    const match = ref.match(/[A-Z]+-\d+|GH-\d+/i);
    ticketId = match ? match[0] : null;
  } catch {
    try {
      const dotgit = fs.readFileSync('.git', 'utf-8').trim();
      if (dotgit.startsWith('gitdir: ')) {
        const gitdir = path.resolve(dotgit.slice('gitdir: '.length));
        const head = fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf-8').trim();
        const ref = head.startsWith('ref: ') ? head.slice(5) : head;
        const match = ref.match(/[A-Z]+-\d+|GH-\d+/i);
        ticketId = match ? match[0] : null;
      }
    } catch {
      ticketId = null;
    }
  }

  if (!ticketId) return; // No ticket context → allow

  // Check if PR has any review comments
  let prComments;
  try {
    const prJson = execSync('gh pr view --json number', {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
    const pr = JSON.parse(prJson);
    if (!pr.number) return;

    const commentsJson = execSync(
      `gh api repos/{owner}/{repo}/pulls/${pr.number}/comments --jq 'length'`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();
    prComments = parseInt(commentsJson, 10);
  } catch {
    return; // Can't fetch PR — fail-open
  }

  if (!prComments || prComments === 0) return; // No comments → allow

  // Check for accountability file
  const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
  const TASKS_BASE =
    getConfig('TASKS_BASE') || path.join(getConfig.orExit('WORKTREES_BASE'), 'tasks');
  let safeTicketId = ticketId;
  try {
    safeTicketId = require(path.join(__dirname, '..', '..', 'lib', 'config')).safeTicketId(
      ticketId
    );
  } catch {}
  const accountabilityFile = path.join(TASKS_BASE, safeTicketId, 'review-accountability.json');

  if (!fs.existsSync(accountabilityFile)) {
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

  // Validate accountability file covers all comments
  try {
    const accountability = JSON.parse(fs.readFileSync(accountabilityFile, 'utf-8'));
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

    // Check all entries have required fields
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
  } catch (err) {
    process.stderr.write(`BLOCKED: Failed to parse review-accountability.json: ${err.message}\n`);
    process.exit(2);
  }
}

main().catch((err) => {
  logHookError(__filename, err);
  if (DEBUG) process.stderr.write(`[enforce-review-accountability] fatal: ${err?.message}\n`);
});
