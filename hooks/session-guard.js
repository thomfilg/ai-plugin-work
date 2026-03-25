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
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Cached TASKS_BASE resolution — loaded once per invocation
const getConfig = require(path.join(__dirname, '..', 'lib', 'get-config'));

let _tasksBase;
function getTasksBase() {
  if (_tasksBase) return _tasksBase;
  _tasksBase = getConfig.orExit('TASKS_BASE');
  return _tasksBase;
}

// Allow disabling session guard entirely via env var
if (process.env.SESSION_GUARD_ENABLED === '0') {
  process.exit(0);
}

// Fail-open in hook mode: never block due to our own bugs
// CLI mode surfaces errors with non-zero exit codes for debuggability
const isHookMode = Boolean(process.env.CLAUDE_HOOK_TYPE);
if (isHookMode) {
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
}

// Session files live in /tmp by default. Files are created with mode 0o600 and
// ownership is verified before reading, but passphrases are stored in plaintext.
// This is acceptable for a single-user local CLI tool — not for shared CI hosts.
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
  // Verify resolved path stays under SESSION_DIR (handle root "/" where baseDir + sep = "//")
  const prefix = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
  if (!resolved.startsWith(prefix) && resolved !== baseDir) {
    throw new Error('Invalid ticketId: resolved path escapes SESSION_DIR');
  }
  return resolved; // validated: stays under SESSION_DIR
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
    const filePath = sessionFilePath(ticketId);
    // Verify ownership before reading (same check as findActiveSessions)
    if (typeof process.getuid === 'function') {
      const stat = fs.statSync(filePath);
      if (stat.uid !== process.getuid()) return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write session data atomically: write to tmp → unlink existing target → rename tmp → target.
 * Ensures SESSION_DIR exists, handles Windows (where rename fails if target exists),
 * and cleans up the tmp file on any error.
 */
function writeSessionAtomic(ticketId, data) {
  const target = sessionFilePath(ticketId);
  // Ensure the directory exists (SESSION_GUARD_DIR may point to a non-default/non-existent path)
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    // Unlink existing target before rename (required on Windows where rename fails if target exists)
    try { fs.unlinkSync(target); } catch { /* ENOENT — target doesn't exist yet */ }
    fs.renameSync(tmp, target);
  } catch (renameErr) {
    try { fs.unlinkSync(tmp); } catch { /* cleanup best-effort */ }
    throw renameErr;
  }
}

/**
 * Find all active session guard files in SESSION_DIR.
 * Checks file ownership before reading content to avoid parsing untrusted files.
 * Filters by filename prefix rather than scanning all of SESSION_DIR.
 */
function findActiveSessions() {
  const sessions = [];
  const baseDir = path.resolve(SESSION_DIR);
  try {
    const prefix = 'claude-session-guard-';
    const suffix = '.json';
    for (const f of fs.readdirSync(baseDir)) {
      if (!f.startsWith(prefix) || !f.endsWith(suffix)) continue;
      const fullPath = path.resolve(baseDir, f);
      if (!fullPath.startsWith(baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep)) continue;
      try {
        // Check ownership BEFORE reading content to skip untrusted files early
        if (typeof process.getuid === 'function') {
          const stat = fs.statSync(fullPath);
          if (stat.uid !== process.getuid()) continue;
        }
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        // Validate schema: must have ticketId + workflow + passphrase to be a real session
        if (data?.ticketId && data?.workflow && data?.passphrase) sessions.push(data);
      } catch { /* skip corrupt or inaccessible files */ }
    }
  } catch { /* can't read SESSION_DIR — fail open */ }
  return sessions;
}

// ─── CLI Subcommands ─────────────────────────────────────────────────────────

function cmdInit(ticketId, workflow) {
  if (!ticketId || !workflow) {
    process.stderr.write('Usage: session-guard.js init <ticketId> <workflow>\n');
    process.exit(1);
  }

  // Idempotent: reuse existing session if one exists for this ticket
  const existing = readSessionFile(ticketId);
  if (existing && existing.ticketId === ticketId) {
    process.stderr.write(`Session guard already active for ${ticketId} (${existing.workflow}). Reusing existing session.\n`);
    process.exit(0);
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
  process.stderr.write(`Session guard active for ${ticketId} (${workflow}). Locked until all steps complete.\n`);
  process.exit(0);
}

function cmdReveal(ticketId) {
  if (!ticketId) {
    process.stderr.write('Usage: session-guard.js reveal <ticketId>\n');
    process.exit(1);
  }

  const session = readSessionFile(ticketId);
  if (!session) {
    process.stderr.write(`No active session for ${ticketId} (skipping reveal)\n`);
    process.exit(0); // fail-open: don't break complete step if guard wasn't initialized
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

/**
 * Atomic teardown: reveal passphrase then remove session file.
 * Replaces the fragile 3-step agent prompt with a single command.
 * Fail-open: exits 0 if no session exists (guard may be disabled).
 */
function cmdFinish(ticketId) {
  if (!ticketId) {
    process.stderr.write('Usage: session-guard.js finish <ticketId>\n');
    process.exit(1);
  }

  const session = readSessionFile(ticketId);
  if (!session) {
    process.stderr.write(`No active session for ${ticketId} (skipping finish)\n`);
    process.exit(0);
  }

  // Reveal passphrase (unlock Stop hook)
  process.stdout.write(session.passphrase + '\n');
  session.revealed = true;
  writeSessionAtomic(ticketId, session);

  // Clean up session file
  try {
    fs.unlinkSync(sessionFilePath(ticketId));
  } catch { /* already gone — fine */ }
  process.stderr.write(`Session guard finished for ${ticketId}\n`);
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

/**
 * Check if the /check workflow is actively running for a ticket.
 * When /check is active, the session guard should not block stops
 * because /check has its own quality gates and state management.
 */
function isCheckWorkflowActive(ticketId) {
  try {
    // Validate ticketId to prevent path traversal
    if (!ticketId || /[/\\:\0]/.test(ticketId)) return false;

    const tasksBase = getTasksBase();
    const resolved = path.resolve(tasksBase, ticketId, '.workflow-state.json');
    // Guard against path traversal — resolved path must stay under tasksBase
    if (!resolved.startsWith(path.resolve(tasksBase) + path.sep)) return false;

    const state = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
    return state?.workflow === 'check' && state?.status === 'in_progress';
  } catch {
    return false;
  }
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

  // Allow stop only if ALL unrevealed sessions have /check active
  const nonCheckSessions = unrevealed.filter(s => !isCheckWorkflowActive(s.ticketId));
  if (nonCheckSessions.length === 0) {
    process.exit(0); // All sessions are under /check — allow stop
    return;
  }

  const session = nonCheckSessions[0];
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
    case 'finish':
      cmdFinish(args[1]);
      break;
    case 'status':
      cmdStatus(args[1]);
      break;
    default:
      process.stderr.write(
        'Usage: session-guard.js <init|reveal|complete|finish|status> [args]\n' +
        '  init <ticketId> <workflow>  — Start session guard\n' +
        '  reveal <ticketId>           — Reveal passphrase\n' +
        '  complete <ticketId>         — Clear session\n' +
        '  finish <ticketId>           — Reveal + complete (atomic teardown)\n' +
        '  status [ticketId]           — Show session info\n'
      );
      process.exit(1);
  }
}

main().catch((err) => {
  if (isHookMode) {
    process.exit(0); // fail-open in hook mode
  } else {
    process.stderr.write(`session-guard error: ${err.message}\n`);
    process.exit(1); // surface errors in CLI mode
  }
});
