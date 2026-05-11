#!/usr/bin/env node
/**
 * enforce-follow-up-script.js — PreToolUse hook (Bash matcher)
 *
 * When a follow-up2 session is active for the current ticket,
 * blocks manual CI checks (gh run, gh pr checks, gh pr view)
 * and forces the agent to use /follow-up2 instead.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Fail-open: never block due to our own bugs
try {
  const input = JSON.parse(fs.readFileSync('/dev/stdin', 'utf8'));
  const cmd = (input.tool_input && input.tool_input.command) || '';

  // Only care about gh commands that check CI status
  if (!/gh\s+(run\s+(list|view|watch)|pr\s+(checks|view\b.*status))/.test(cmd)) {
    process.exit(0);
  }

  // Check if a follow-up2 session is active
  let tasksBase;
  try {
    const getConfig = require(path.join(__dirname, '..', 'workflows', 'lib', 'get-config'));
    tasksBase = getConfig('TASKS_BASE');
  } catch {
    process.exit(0); // Can't determine tasks base — fail-open
  }

  if (!tasksBase) {
    process.exit(0);
  }

  // Determine current ticket from branch name or cwd
  let currentTicket = '';
  try {
    const { getCurrentTaskId } = require(
      path.join(__dirname, '..', 'workflows', 'lib', 'scripts', 'get-ticket-id')
    );
    currentTicket = getCurrentTaskId() || '';
  } catch {
    // Can't determine ticket — check all sessions (fallback)
  }

  // Check if the CURRENT ticket has an active follow-up2 session
  let found = false;
  try {
    const entries = fs.readdirSync(tasksBase);
    for (const entry of entries) {
      // Only check the current ticket's session (or all if ticket unknown)
      if (currentTicket && entry !== currentTicket) continue;

      const statePath = path.join(tasksBase, entry, '.follow-up2-state.json');
      try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (state.status === 'in_progress') {
          found = true;
          const ticketId = state.ticketId || entry;
          const prNumber = state.prNumber || '';
          console.error(
            `BLOCKED: Active /follow-up2 session for ${ticketId}.\n\n` +
              `Do NOT check CI manually. Use /follow-up2 instead — it handles CI monitoring, review comments, and fixes.\n\n` +
              `Run: /follow-up2\n` +
              `Or: node "\${CLAUDE_PLUGIN_ROOT}/scripts/workflows/follow-up2/follow-up-next.js" "${ticketId}"${prNumber ? ` --pr ${prNumber}` : ''}`
          );
          break;
        }
      } catch {
        // Not a valid state file — skip
      }
    }
  } catch {
    process.exit(0); // Can't read tasks dir — fail-open
  }

  if (found) {
    process.exit(2); // Block
  }
  process.exit(0);
} catch {
  process.exit(0); // Fail-open
}
