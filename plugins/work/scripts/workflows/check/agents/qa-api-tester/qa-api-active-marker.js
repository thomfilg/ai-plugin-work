#!/usr/bin/env node
'use strict';

/**
 * Toggle a `.qa-api-agent-active` marker file inside the active ticket's
 * tasks folder. Used by the agent-hook-dispatcher to mark when
 * qa-api-tester is in flight (set) and clean up afterward (clear).
 *
 * Usage:
 *   node qa-api-active-marker.js set
 *   node qa-api-active-marker.js clear
 *
 * Resolves TASKS_BASE via the shared lib/get-config helper rather than
 * hardcoding a worktree-specific path.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const getConfig = require(path.join(__dirname, '..', '..', '..', 'lib', 'get-config'));
const { logHookError } = require(path.join(__dirname, '..', '..', '..', 'lib', 'hook-error-log'));

process.on('uncaughtException', (err) => {
  logHookError(__filename, err);
  process.exit(0);
});

function resolveTicket() {
  const ticketScript = path.join(__dirname, '..', '..', '..', 'lib', 'scripts', 'get-ticket-id.js');
  try {
    const out = execSync(`node "${ticketScript}"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim();
  } catch {
    return '';
  }
}

function main() {
  const action = process.argv[2];
  if (action !== 'set' && action !== 'clear') process.exit(0);

  const ticket = resolveTicket();
  if (!ticket) process.exit(0);

  const tasksBase = getConfig('TASKS_BASE');
  if (!tasksBase) process.exit(0);

  const ticketDir = path.join(tasksBase, ticket);
  const marker = path.join(ticketDir, '.qa-api-agent-active');

  if (action === 'set') {
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(marker, '');
  } else {
    try {
      fs.unlinkSync(marker);
    } catch {
      /* ignore missing */
    }
  }
  process.exit(0);
}

main();
