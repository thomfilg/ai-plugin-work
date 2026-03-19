#!/usr/bin/env node

/**
 * session-guard.js — Multi-purpose session guard for /work and /follow-up-pr
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
 *   status [ticketId]            — Show session info
 *
 * Hook events (via CLAUDE_HOOK_TYPE env var):
 *   PreCompact — Output workflow reminder to stdout
 *   Stop       — Block stop if unrevealed session exists
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Fail-open in hook mode: never block due to our own bugs
// CLI mode surfaces errors with non-zero exit codes for debuggability
const isHookMode = !!process.env.CLAUDE_HOOK_TYPE;
if (isHookMode) {
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
}

const SESSION_DIR = process.env.SESSION_GUARD_DIR || '/tmp';

// NATO phonetic alphabet words for passphrase generation
const NATO_WORDS = [
  'ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT',
  'GOLF', 'HOTEL', 'INDIA', 'JULIET', 'KILO', 'LIMA',
  'MIKE', 'NOVEMBER', 'OSCAR', 'PAPA', 'QUEBEC', 'ROMEO',
  'SIERRA', 'TANGO', 'UNIFORM', 'VICTOR', 'WHISKEY', 'XRAY',
  'YANKEE', 'ZULU',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sanitizeTicketId(ticketId) {
  // Strip path separators and null bytes to prevent path traversal
  const sanitized = String(ticketId).replace(/[/\\:\0]/g, '_');
  const baseDir = path.resolve(SESSION_DIR);
  const resolved = path.resolve(baseDir, `claude-session-guard-${sanitized}.json`);
  // Verify resolved path stays under SESSION_DIR
  if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
    throw new Error(`Invalid ticketId: resolved path escapes SESSION_DIR`);
  }
  return resolved;
}

function sessionFilePath(ticketId) {
  return sanitizeTicketId(ticketId);
}

function generatePassphrase() {
  const w1 = NATO_WORDS[crypto.randomInt(NATO_WORDS.length)];
  const w2 = NATO_WORDS[crypto.randomInt(NATO_WORDS.length)];
  const num = String(crypto.randomInt(10000)).padStart(4, '0');
  return `${w1}-${w2}-${num}`;
}

function readSessionFile(ticketId) {
  try {
    return JSON.parse(fs.readFileSync(sessionFilePath(ticketId), 'utf8'));
  } catch {
    return null;
  }
}

function writeSessionAtomic(ticketId, data) {
  const target = sessionFilePath(ticketId);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/**
 * Find all active session guard files in /tmp
 */
function findActiveSessions() {
  const sessions = [];
  try {
    const files = fs.readdirSync(SESSION_DIR);
    for (const f of files) {
      if (!f.startsWith('claude-session-guard-') || !f.endsWith('.json')) continue;
      try {
        const fullPath = path.join(SESSION_DIR, f);
        if (!fullPath.startsWith(SESSION_DIR + path.sep)) continue;
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        if (data && data.ticketId) sessions.push(data);
      } catch { /* skip corrupt files */ }
    }
  } catch { /* can't read /tmp — fail open */ }
  return sessions;
}

// ─── CLI Subcommands ─────────────────────────────────────────────────────────

function cmdInit(ticketId, workflow) {
  if (!ticketId || !workflow) {
    process.stderr.write('Usage: session-guard.js init <ticketId> <workflow>\n');
    process.exit(1);
  }

  const passphrase = generatePassphrase();
  const session = {
    ticketId,
    workflow,
    passphrase,
    startTime: new Date().toISOString(),
    revealed: false,
  };

  writeSessionAtomic(ticketId, session);
  process.stderr.write(`Session guard active for ${ticketId} (${workflow}). Workflow locked until all steps complete.\n`);
  process.exit(0);
}

function cmdReveal(ticketId) {
  if (!ticketId) {
    process.stderr.write('Usage: session-guard.js reveal <ticketId>\n');
    process.exit(1);
  }

  const session = readSessionFile(ticketId);
  if (!session) {
    process.stderr.write(`No active session for ${ticketId}\n`);
    process.exit(1);
  }

  // Output passphrase to stdout
  process.stdout.write(session.passphrase + '\n');

  // Update revealed flag
  session.revealed = true;
  writeSessionAtomic(ticketId, session);
  process.exit(0);
}

function cmdComplete(ticketId) {
  if (!ticketId) {
    process.stderr.write('Usage: session-guard.js complete <ticketId>\n');
    process.exit(1);
  }

  try {
    fs.unlinkSync(sessionFilePath(ticketId));
  } catch { /* already gone — fine */ }
  process.stderr.write(`Session guard cleared for ${ticketId}\n`);
  process.exit(0);
}

function cmdStatus(ticketId) {
  if (ticketId) {
    const session = readSessionFile(ticketId);
    if (session) {
      process.stdout.write(JSON.stringify({
        ticketId: session.ticketId,
        workflow: session.workflow,
        startTime: session.startTime,
        revealed: session.revealed,
      }, null, 2) + '\n');
    } else {
      process.stdout.write(`No active session for ${ticketId}\n`);
    }
  } else {
    const sessions = findActiveSessions();
    if (sessions.length === 0) {
      process.stdout.write('No active sessions\n');
    } else {
      process.stdout.write(JSON.stringify(sessions.map(s => ({
        ticketId: s.ticketId,
        workflow: s.workflow,
        startTime: s.startTime,
        revealed: s.revealed,
      })), null, 2) + '\n');
    }
  }
  process.exit(0);
}

// ─── Hook Handlers ───────────────────────────────────────────────────────────

function handlePreCompact() {
  const sessions = findActiveSessions();
  if (sessions.length === 0) {
    process.exit(0);
    return;
  }

  const lines = [];
  for (const session of sessions) {
    lines.push(
      `ACTIVE WORKFLOW SESSION - DO NOT ABANDON`,
      `Workflow: ${session.workflow} | Ticket: ${session.ticketId}`,
      `You MUST continue this workflow. Run: ${session.workflow} ${session.ticketId}`,
      `The session is locked with a passphrase. Complete all steps to unlock.`,
      ''
    );
  }

  process.stdout.write(lines.join('\n'));
  process.exit(0);
}

function handleStop(hookData) {
  const sessions = findActiveSessions();
  if (sessions.length === 0) {
    process.exit(0);
    return;
  }

  // Check for abort keyword in stop message
  const stopMessage = hookData?.stop_message || '';
  if (/abort\s+workflow/i.test(stopMessage)) {
    process.exit(0);
    return;
  }

  // Check if any session is unrevealed
  const unrevealed = sessions.filter(s => !s.revealed);
  if (unrevealed.length === 0) {
    process.exit(0);
    return;
  }

  const session = unrevealed[0];
  process.stderr.write(
    `BLOCKED: Active workflow session for ${session.ticketId} (${session.workflow}). ` +
    `Complete all ${session.workflow} steps to unlock, or type 'abort workflow' to force-stop.\n`
  );
  process.exit(2);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const hookType = process.env.CLAUDE_HOOK_TYPE;

  // Hook mode: read stdin and dispatch by hook type
  if (hookType) {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
    }

    let hookData = {};
    try { hookData = JSON.parse(input); } catch { /* empty/invalid — use default */ }

    // Prevent infinite loops in Stop hooks
    if (hookType === 'Stop' && hookData.stop_hook_active) {
      process.exit(0);
      return;
    }

    switch (hookType) {
      case 'PreCompact':
        handlePreCompact();
        break;
      case 'Stop':
        handleStop(hookData);
        break;
      default:
        process.exit(0);
    }
    return;
  }

  // CLI mode: parse subcommand from argv
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'init':
      cmdInit(args[1], args[2]);
      break;
    case 'reveal':
      cmdReveal(args[1]);
      break;
    case 'complete':
      cmdComplete(args[1]);
      break;
    case 'status':
      cmdStatus(args[1]);
      break;
    default:
      process.stderr.write(
        'Usage: session-guard.js <init|reveal|complete|status> [args]\n' +
        '  init <ticketId> <workflow>  — Start session guard\n' +
        '  reveal <ticketId>           — Reveal passphrase\n' +
        '  complete <ticketId>         — Clear session\n' +
        '  status [ticketId]           — Show session info\n'
      );
      process.exit(1);
  }
}

main().catch(() => process.exit(0));
