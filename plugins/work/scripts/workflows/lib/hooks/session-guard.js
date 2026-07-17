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
 *   init <ticketId> <workflow> [--show-guard]
 *                                — Create session with passphrase; reuse ticks
 *                                  are silent unless the guard state changed
 *                                  (--show-guard prints the status on demand)
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

// Hook mode vs CLI mode discriminator (GH-774): the orchestrator always
// invokes the CLI with a positional subcommand (init/reveal/…); the host
// runtime fires the hook with NO argv and pipes a payload on stdin. Keying
// off argv — not CLAUDE_HOOK_TYPE — fixes codex, which sets no CLAUDE_* env
// (a codex Stop fell through to the CLI branch and exited 1: the observed
// "Stop hook failed: exited with code 1").
const CLI_POSITIONALS = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));

// Fail-open in hook mode: never block due to our own bugs
// CLI mode surfaces errors with non-zero exit codes for debuggability
const isHookMode = CLI_POSITIONALS.length === 0;
if (isHookMode) {
  for (const fatalEvent of ['uncaughtException', 'unhandledRejection']) {
    process.on(fatalEvent, (err) => {
      logHookError(__filename, err);
      process.exit(0);
    });
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function runHookMode() {
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

  // Resolve the event payload-first: CLAUDE_HOOK_TYPE (claude) then
  // hook_event_name (codex sets no CLAUDE_* env — ground truth §2.7.2).
  const hookType = process.env.CLAUDE_HOOK_TYPE || hookData.hook_event_name;

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
  // GH-540: reuse ticks are silent by default; `--show-guard` opts back into
  // printing the guard status even when the announce-state is unchanged.
  const showGuard = args.includes('--show-guard');
  const positional = args.filter((arg) => arg !== '--show-guard');
  switch (positional[0]) {
    case 'init':
      commands.cmdInit(positional[1], positional[2], { showGuard });
      break;
    case 'reveal':
      commands.cmdReveal(positional[1]);
      break;
    case 'complete':
      commands.cmdComplete(positional[1], positional[2]);
      break;
    case 'finish':
      commands.cmdFinish(positional[1]);
      break;
    case 'status':
      commands.cmdStatus(positional[1]);
      break;
    default:
      process.stderr.write(
        'Usage: session-guard.js <init|reveal|complete|finish|status> [args]\n' +
          '  init <ticketId> <workflow> [--show-guard]  — Start session guard\n' +
          '  reveal <ticketId>           — Reveal passphrase\n' +
          '  complete <ticketId> [wf]    — Clear session (optional workflow filter)\n' +
          '  finish <ticketId>           — Reveal + complete (atomic teardown)\n' +
          '  status [ticketId]           — Show session info\n'
      );
      process.exit(1);
  }
}

async function main() {
  // Hook mode: no CLI subcommand in argv — read stdin and dispatch by event.
  if (isHookMode) {
    await runHookMode();
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
