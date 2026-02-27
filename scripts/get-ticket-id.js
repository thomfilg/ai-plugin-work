#!/usr/bin/env node
/**
 * Get current JIRA ticket ID from worktree path or git branch.
 *
 * Usage: node get-ticket-id.js
 * Output: PROJ-XXX or empty string if not found
 */

const { execSync } = require('child_process');

const TICKET_PATTERN = /([A-Z]+-\d+)/i;

function getCurrentTaskId(cwd = process.cwd()) {
  // Try to get from worktree folder name
  const worktreeMatch = cwd.match(TICKET_PATTERN);
  if (worktreeMatch) {
    return worktreeMatch[1].toUpperCase();
  }

  // Try to get from git branch name
  try {
    const branch = execSync('git branch --show-current', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    const branchMatch = branch.match(TICKET_PATTERN);
    if (branchMatch) {
      return branchMatch[1].toUpperCase();
    }
  } catch {
    // Ignore git errors
  }

  return '';
}

if (require.main === module) {
  console.log(getCurrentTaskId());
}

module.exports = { getCurrentTaskId };
