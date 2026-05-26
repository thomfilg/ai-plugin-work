#!/usr/bin/env node
'use strict';

/**
 * monitor-manager.js
 *
 * Tails the MONITOR channel and acts as a lightweight workflow manager
 * for agent sessions. Two responsibilities:
 *
 *   1. AUTO-WELCOME — on the first message it sees from a given ticket
 *      (detected by a `TICKET-ID:` prefix in the line), it sends a
 *      welcome message to that ticket's channel with a help list of
 *      questions the agent can ask the manager.
 *
 *   2. CLEANUP TRACKING — on lines containing the `__MONITOR_DONE__`
 *      sentinel it marks the ticket completed, prints a status line,
 *      and (optionally, with --archive) moves the ticket's log file
 *      into `<INBOX_DIR>/archived/`.
 *
 * Usage:
 *   node monitor-manager.js                # MONITOR channel, no archiving
 *   node monitor-manager.js --archive      # also archive completed channels
 *   node monitor-manager.js --channel FOO  # use FOO instead of MONITOR
 *
 * The welcome text lives in `WELCOME_MESSAGE` below so it can be tuned
 * without touching parsing logic.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const INBOX_DIR = process.env.CLAUDE_AGENT_INBOX_DIR || '/tmp/claude-agent-inbox';
const DONE_SENTINEL = '__MONITOR_DONE__';

// Matches ticket-id prefix like "ECHO-4560:", "GH-365:", "APPSUPEN-1119:",
// "PR-1547:" — anchored at start (after the [timestamp] prefix the inbox
// format already prepends) or stand-alone.
const TICKET_PREFIX_RE = /(?:^|\]\s*)([A-Z][A-Z0-9_]*-\d+|PR-\d+|GH-\d+)\s*:/;

const WELCOME_MESSAGE = [
  "Hi — I'm the workflow manager. If anything blocks you during the workflow,",
  'send a message to the MONITOR channel and I will help unblock you.',
  '',
  'Questions you can ask:',
  '  - "I\'m stuck on step X because of script Y" (state-machine transition issues)',
  '  - "task-next.js / brief-next.js returned No valid write token found" (hook/token mint failures)',
  '  - "TDD phase gating won\'t let me edit file F" (RED/GREEN/REFACTOR phase restrictions)',
  '  - "Workflow won\'t advance to <step> — gate says <reason>" (Gate 0-8 enforcement)',
  '  - "PR CI failing on test <name> — looks pre-existing/unclear" (CI triage)',
  '  - "Hook is blocking my Bash/Edit/Write with <message>" (PreToolUse hook misfires)',
  '  - "I see a stale workflow lock from another ticket" (session-guard interference)',
  '  - "TDD evidence missing / can\'t record RED->GREEN cycle" (tdd-phase-state issues)',
  '  - "Plugin script throws <error> — looks like a bug" (script bugs to escalate)',
  '',
  'When the workflow is done on your end, run:',
  '  node $CLAUDE_PLUGIN_ROOT/scripts/communicate.js --done <YOUR-TICKET>',
  'That signals completion to MONITOR and stops your local listener cleanly.',
].join(' \\n ');
// Note: stored as a single line (newlines escaped with " \n ") so the
// channel log stays one-line-per-message. listeners print them verbatim;
// agents reading raw log content can replace " \n " with real newlines.

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { channel: 'MONITOR', archive: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--archive') opts.archive = true;
    else if (a === '--channel') opts.channel = (args[++i] || 'MONITOR').toUpperCase();
    else if (a === '-h' || a === '--help') {
      process.stderr.write(
        'usage: monitor-manager.js [--channel MONITOR] [--archive]\n' +
          '  Tails the MONITOR channel and auto-welcomes new ticket senders.\n' +
          '  On __MONITOR_DONE__ lines, marks the ticket complete and (with --archive)\n' +
          '  moves the ticket log into <INBOX_DIR>/archived/.\n'
      );
      process.exit(0);
    } else {
      process.stderr.write(`unknown arg: ${a}\n`);
      process.exit(1);
    }
  }
  return opts;
}

function extractTicket(line) {
  const m = line.match(TICKET_PREFIX_RE);
  return m ? m[1].toUpperCase() : null;
}

function sendTo(ticket, text) {
  const inbox = path.join(INBOX_DIR, `${ticket}.log`);
  if (!fs.existsSync(inbox)) fs.closeSync(fs.openSync(inbox, 'a'));
  const ts = new Date().toISOString();
  fs.appendFileSync(inbox, `[${ts}] MONITOR: ${text}\n`, { mode: 0o644 });
}

function archiveChannel(ticket) {
  const src = path.join(INBOX_DIR, `${ticket}.log`);
  if (!fs.existsSync(src)) return false;
  const archDir = path.join(INBOX_DIR, 'archived');
  fs.mkdirSync(archDir, { recursive: true, mode: 0o755 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(archDir, `${ticket}.${stamp}.log`);
  try {
    fs.renameSync(src, dest);
    return dest;
  } catch {
    return false;
  }
}

function main() {
  const opts = parseArgs(process.argv);
  fs.mkdirSync(INBOX_DIR, { recursive: true, mode: 0o755 });
  const inbox = path.join(INBOX_DIR, `${opts.channel}.log`);
  if (!fs.existsSync(inbox)) fs.closeSync(fs.openSync(inbox, 'a'));

  const welcomed = new Set();
  const completed = new Set();

  process.stdout.write(
    `monitor-manager: tailing ${inbox}\n` +
      `  auto-welcome: on\n` +
      `  archive on done: ${opts.archive ? 'on' : 'off'}\n` +
      `  Ctrl-C to stop.\n`
  );

  const tail = spawn('tail', ['-n', '0', '-F', inbox], { stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = '';
  tail.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line) continue;
      handleLine(line);
    }
  });
  tail.on('exit', (code) => process.exit(code ?? 0));
  process.on('SIGINT', () => tail.kill('SIGINT'));
  process.on('SIGTERM', () => tail.kill('SIGTERM'));

  function handleLine(line) {
    process.stdout.write(`\x07[${opts.channel}] ${line}\n`);
    const ticket = extractTicket(line);
    if (!ticket) return;

    if (line.includes(DONE_SENTINEL)) {
      if (completed.has(ticket)) return;
      completed.add(ticket);
      const archived = opts.archive ? archiveChannel(ticket) : false;
      process.stdout.write(
        `  -> [${ticket}] marked COMPLETE` +
          (archived ? ` (archived to ${archived})` : '') +
          ` (total completed: ${completed.size})\n`
      );
      return;
    }

    if (!welcomed.has(ticket)) {
      welcomed.add(ticket);
      sendTo(ticket, WELCOME_MESSAGE);
      process.stdout.write(
        `  -> [${ticket}] first contact — welcome sent (total welcomed: ${welcomed.size})\n`
      );
    }
  }
}

if (require.main === module) main();

module.exports = { extractTicket, TICKET_PREFIX_RE, DONE_SENTINEL, WELCOME_MESSAGE };
