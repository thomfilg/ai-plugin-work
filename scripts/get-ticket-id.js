#!/usr/bin/env node
/**
 * Get current JIRA ticket ID from worktree path or git branch.
 *
 * Usage: node get-ticket-id.js
 * Output: PROJ-XXX or empty string if not found
 */

const { execSync } = require('child_process');

const TICKET_PATTERN = /([A-Z]+-\d+)/i;
const NUMERIC_PATTERN = /(\d+)/;

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

  // Fallback: try numeric pattern for GitHub Issues provider
  try {
    const tp = require('../lib/ticket-provider');
    const providerConfig = tp.getProviderConfig({ skipPrompt: true });
    if (providerConfig && providerConfig.provider === 'github') {
      const numericMatch = cwd.match(NUMERIC_PATTERN);
      if (numericMatch) return '#' + numericMatch[1];
      try {
        const branch = execSync('git branch --show-current', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        const branchNum = branch.match(NUMERIC_PATTERN);
        if (branchNum) return '#' + branchNum[1];
      } catch {}
    }
  } catch {}

  return '';
}

if (require.main === module) {
  console.log(getCurrentTaskId());
}

module.exports = { getCurrentTaskId };
