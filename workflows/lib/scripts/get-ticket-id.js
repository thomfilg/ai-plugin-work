#!/usr/bin/env node
/**
 * Get current JIRA ticket ID from worktree path or git branch.
 *
 * Usage: node get-ticket-id.js
 * Output: PROJ-XXX or empty string if not found
 */

const { execSync } = require('child_process');

const TICKET_PATTERN = /([A-Z]+-\d+)/i;
const GH_PATTERN = /GH-(\d+)/i;

function getCurrentTaskId(cwd = process.cwd()) {
  // Try GH-XX pattern first (for GitHub Issues worktree paths like my-project-GH-56)
  // Return GH-N (path-safe) instead of #N to avoid filesystem issues with # in directory names
  const ghMatch = cwd.match(GH_PATTERN);
  if (ghMatch) {
    return 'GH-' + ghMatch[1];
  }

  // Try to get from worktree folder name (Jira/Linear: PROJ-123)
  const worktreeMatch = cwd.match(TICKET_PATTERN);
  if (worktreeMatch) {
    return worktreeMatch[1].toUpperCase();
  }

  // Try to get from git branch name
  try {
    const branch = execSync('git branch --show-current', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // Check GH-XX pattern in branch name
    const branchGhMatch = branch.match(GH_PATTERN);
    if (branchGhMatch) {
      return 'GH-' + branchGhMatch[1];
    }
    const branchMatch = branch.match(TICKET_PATTERN);
    if (branchMatch) {
      return branchMatch[1].toUpperCase();
    }
  } catch {
    // Ignore git errors
  }

  // Fallback: try numeric suffix for GitHub Issues provider
  // Only match trailing number after a separator to avoid false positives
  // (e.g. version numbers, user IDs embedded in paths)
  try {
    const tp = require('../ticket-provider');
    const providerConfig = tp.getProviderConfig({ skipPrompt: true });
    if (providerConfig && providerConfig.provider === 'github') {
      const trailingNum = cwd.match(/[-/](\d+)\/?$/);
      if (trailingNum) return 'GH-' + trailingNum[1];
      try {
        const branch = execSync('git branch --show-current', {
          cwd,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        const branchTrailingNum = branch.match(/[-/](\d+)$/);
        if (branchTrailingNum) return 'GH-' + branchTrailingNum[1];
      } catch {}
    }
  } catch {}

  return '';
}

if (require.main === module) {
  console.log(getCurrentTaskId());
}

module.exports = { getCurrentTaskId };
