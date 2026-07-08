#!/usr/bin/env node

/**
 * session-guard.js — Workflow session guard (currently wired for /work only)
 *
 * Prevents AI from getting lost after context compaction by:
 * 1. Generating a passphrase at workflow start (locked until completion)
 * 2. Injecting workflow reminders during PreCompact
 * 3. Blocking premature session stops via Stop hook
 *
 * CLI subcommands (called by orchestrator):
 *   init <ticketId> <workflow>   — Create session with passphrase
 *   reveal <ticketId>            — Reveal passphrase (sets revealed=true)
 *   complete <ticketId>          — Remove session file (cleanup)
 *   finish <ticketId>            — Atomic teardown: reveal + complete
 *   status [ticketId]            — Show session info
 *
 * Hook events (via CLAUDE_HOOK_TYPE env var):
 *   PreCompact — Output workflow reminder to stdout
 *   Stop       — Block stop if unrevealed session exists
 *
 * Implementation lives in ./session-guard/ (store, context, commands,
 * hook-handlers); this entrypoint only dispatches. Its path is registered in
 * hooks.json and spawned by the orchestrator — do not move it.
 */

const path = require('path');

const { logHookError } = require(path.join(__dirname, '..', 'hook-error-log'));
const commands = require(path.join(__dirname, 'session-guard', 'commands'));
const { handlePreCompact, handleStop } = require(
  path.join(__dirname, 'session-guard', 'hook-handlers')
);

// Allow disabling session guard entirely via env var
if (process.env.SESSION_GUARD_ENABLED === '0') {
  process.exit(0);
}

// Fail-open in hook mode: never block due to our own bugs
// CLI mode surfaces errors with non-zero exit codes for debuggability
const isHookMode = Boolean(process.env.CLAUDE_HOOK_TYPE);
if (isHookMode) {
  for (const fatalEvent of ['uncaughtException', 'unhandledRejection']) {
    process.on(fatalEvent, (err) => {
      logHookError(__filename, err);
      process.exit(0);
    });
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function runHookMode(hookType) {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookData = {};
  try {
    hookData = JSON.parse(input);
  } catch {
    /* empty/invalid — use default */
  }

  // Prevent infinite loops in Stop hooks
  if (hookType === 'Stop' && hookData.stop_hook_active) {
    process.exit(0);
    return;
  }

  switch (hookType) {
    case 'PreCompact':
      handlePreCompact(hookData);
      break;
    case 'Stop':
      handleStop(hookData);
      break;
    default:
      process.exit(0);
  }
}

function runCli(args) {
  switch (args[0]) {
    case 'init':
      commands.cmdInit(args[1], args[2]);
      break;
    case 'reveal':
      commands.cmdReveal(args[1]);
      break;
    case 'complete':
      commands.cmdComplete(args[1], args[2]);
      break;
    case 'finish':
      commands.cmdFinish(args[1]);
      break;
    case 'status':
      commands.cmdStatus(args[1]);
      break;
    default:
      process.stderr.write(
        'Usage: session-guard.js <init|reveal|complete|finish|status> [args]\n' +
          '  init <ticketId> <workflow>  — Start session guard\n' +
          '  reveal <ticketId>           — Reveal passphrase\n' +
          '  complete <ticketId> [wf]    — Clear session (optional workflow filter)\n' +
          '  finish <ticketId>           — Reveal + complete (atomic teardown)\n' +
          '  status [ticketId]           — Show session info\n'
      );
      process.exit(1);
  }
}

async function main() {
  const hookType = process.env.CLAUDE_HOOK_TYPE;

  // Hook mode: read stdin and dispatch by hook type
  if (hookType) {
    await runHookMode(hookType);
    return;
  }

  // CLI mode: parse subcommand from argv
  runCli(process.argv.slice(2));
}

main().catch((err) => {
  if (isHookMode) {
    logHookError(__filename, err);
    process.exit(0); // fail-open in hook mode
  } else {
    process.stderr.write(`session-guard error: ${err.message}\n`);
    process.exit(1); // surface errors in CLI mode
  }
});
