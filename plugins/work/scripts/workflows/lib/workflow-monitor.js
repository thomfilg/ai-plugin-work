#!/usr/bin/env node

/**
 * workflow-monitor.js
 *
 * Polls all in-progress tickets, detects stalls, and messages stuck agents
 * via the inbox. Designed to be invoked every 5 minutes by the orchestrator.
 *
 * A ticket is "stuck" when any of:
 *  - debug.md idle > IDLE_HARD_THRESHOLD (15 min) AND no tdd-phase progress in that window
 *  - _tddRetryCount >= RETRY_LOOP_THRESHOLD (20+) — agent is hammering same failure
 *
 * For stuck tickets the monitor sends a single nudge via communicate.js with
 * a structured diagnosis (retry count, error tail, time-since-last-progress).
 * To avoid spamming, nudges are throttled per ticket via a marker file at
 * /tmp/workflow-monitor-nudges/<ticket>.last (epoch seconds).
 *
 * Usage: node workflow-monitor.js [--dry-run] [--tasks-base PATH]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, execSync } = require('child_process');

const IDLE_HARD_THRESHOLD = 15 * 60; // 15 min
const RETRY_LOOP_THRESHOLD = 20;
const FINGERPRINT_LOOP_THRESHOLD = 10; // same error N times in a row
const NUDGE_COOLDOWN = 10 * 60; // 10 min between nudges per ticket
// Only consider a ticket "currently running" if its state file was updated
// within the last 6 hours. Older tickets are abandoned/dormant — never nudge.
const ACTIVE_WINDOW = 6 * 60 * 60;
const NUDGE_STATE_DIR = '/tmp/workflow-monitor-nudges';
const FINGERPRINT_DIR = '/tmp/workflow-monitor-fingerprints';
const LOG_FILE = '/tmp/workflow-monitor.log';
// communicate.js lives at scripts/communicate.js (this monitor is at scripts/workflows/lib/)
const SCRIPTS_ROOT = path.resolve(__dirname, '..', '..');
const COMMUNICATE_SCRIPT = path.join(SCRIPTS_ROOT, 'communicate.js');
const LISTEN_SCRIPT = path.join(SCRIPTS_ROOT, 'listen-communication.js');
const LISTEN_ALL_SCRIPT = path.join(SCRIPTS_ROOT, 'listen-all.js');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const tasksBaseArg = argv.indexOf('--tasks-base');
const explicitBase = tasksBaseArg !== -1 ? argv[tasksBaseArg + 1] : null;

// Discover TASKS_BASE candidates. Single-base case uses the canonical
// `resolveTasksBase()` from lib/ticket-validation. Multi-base (monitoring
// across worktrees) uses an explicit colon-separated $WORKTREES_BASES env.
// No bespoke .envrc parsing — that's already the job of `resolveTasksBase`
// via direnv/shell loading.
const { resolveTasksBaseOrNull } = require('./ticket-validation');

function discoverTasksBases() {
  if (explicitBase) return [explicitBase];
  if (process.env.WORKTREES_BASES) {
    return process.env.WORKTREES_BASES.split(':').filter(Boolean);
  }
  const single = resolveTasksBaseOrNull();
  return single ? [single] : [];
}

const TASKS_BASES = discoverTasksBases();

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function statMtime(p) {
  try {
    return fs.statSync(p).mtimeMs / 1000;
  } catch {
    return null;
  }
}

function latestTddTimestamp(taskDir) {
  // Find newest cycles[].red/green/refactor timestamp across all task<N>/tdd-phase.json
  let newest = 0;
  try {
    const entries = fs.readdirSync(taskDir);
    for (const e of entries) {
      if (!/^task\d+$/.test(e)) continue;
      const tdd = readJsonSafe(path.join(taskDir, e, 'tdd-phase.json'));
      if (!tdd?.cycles) continue;
      for (const c of tdd.cycles) {
        for (const phase of ['red', 'green', 'refactor']) {
          const t = c[phase]?.timestamp;
          if (!t) continue;
          const ts = Math.floor(new Date(t).getTime() / 1000);
          if (ts > newest) newest = ts;
        }
      }
    }
  } catch {
    /* fail-open */
  }
  return newest;
}

function shouldNudge(ticket) {
  try {
    fs.mkdirSync(NUDGE_STATE_DIR, { recursive: true });
    const f = path.join(NUDGE_STATE_DIR, `${ticket}.last`);
    const now = Math.floor(Date.now() / 1000);
    if (fs.existsSync(f)) {
      const last = parseInt(fs.readFileSync(f, 'utf8'), 10) || 0;
      if (now - last < NUDGE_COOLDOWN) return false;
    }
    return true;
  } catch {
    return true;
  }
}

// Record a successful nudge so the cooldown takes effect. Split from
// `shouldNudge` so failed deliveries don't burn the 10-min window — the
// next monitor pass should be free to retry. Fail-open on IO errors.
function recordNudgeSent(ticket) {
  try {
    fs.mkdirSync(NUDGE_STATE_DIR, { recursive: true });
    const f = path.join(NUDGE_STATE_DIR, `${ticket}.last`);
    fs.writeFileSync(f, String(Math.floor(Date.now() / 1000)));
  } catch {
    /* fail-open */
  }
}

// Returns true on successful delivery, false on failure (so the caller
// can skip recording the cooldown marker and retry on the next pass).
function sendNudge(ticket, message) {
  if (dryRun) {
    process.stdout.write(`[dry-run] would nudge ${ticket}: ${message.slice(0, 100)}\n`);
    return true;
  }
  try {
    execFileSync('node', [COMMUNICATE_SCRIPT, ticket, message], {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: 'pipe',
    });
    return true;
  } catch (err) {
    process.stderr.write(`nudge to ${ticket} failed: ${err.message}\n`);
    return false;
  }
}

// Fingerprint = hash of normalized retry reason + first/last line of error tail.
// Stable across timestamps/line wrapping so consecutive retries with the same
// failure share a fingerprint.
function computeFingerprint(st) {
  if (!st._tddRetryReason && !st._tddRetryOutputTail) return null;
  const reason = String(st._tddRetryReason || '')
    .replace(/\s+/g, ' ')
    .trim();
  const tail = String(st._tddRetryOutputTail || '')
    .split('\n')
    .filter((l) => l.trim() && !/^\s*\[\d/.test(l)) // drop timestamps
    .map((l) =>
      l
        .replace(/\b\d+\b/g, 'N')
        .replace(/0x[0-9a-f]+/gi, 'HEX')
        .slice(0, 200)
    )
    .join('|');
  return crypto
    .createHash('sha1')
    .update(reason + '||' + tail)
    .digest('hex')
    .slice(0, 12);
}

// Returns { same: N } — count of consecutive cycles with the same fingerprint.
// Persists in /tmp so it survives between monitor invocations.
function recordFingerprint(ticket, fp) {
  if (!fp) return { same: 0 };
  try {
    fs.mkdirSync(FINGERPRINT_DIR, { recursive: true });
    const f = path.join(FINGERPRINT_DIR, `${ticket}.json`);
    let prev = { fp: null, count: 0 };
    if (fs.existsSync(f)) {
      try {
        prev = JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch {
        /* ignore */
      }
    }
    const same = prev.fp === fp ? prev.count + 1 : 1;
    fs.writeFileSync(f, JSON.stringify({ fp, count: same }));
    return { same };
  } catch {
    return { same: 0 };
  }
}

// Capture diagnostic snapshot the agent can't easily see: tmux sessions, port/
// file locks for the worktree's likely DB files. Best-effort, fail-open.
function captureDiagnosticSnapshot(ticket, tasksBase) {
  const lines = [];
  const tryRun = (cmd, label) => {
    try {
      const out = execSync(cmd, {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (out) {
        lines.push(`--- ${label} ---`);
        lines.push(out);
      }
    } catch {
      /* fail-open */
    }
  };

  // tmux sessions matching the ticket
  tryRun(`tmux ls 2>/dev/null | grep -E '${ticket}' || true`, 'tmux sessions');

  // worktree path = parent(tasksBase) + likely worktree dir naming. We don't
  // know the exact worktree path, so check the parent for *<ticket>* dirs.
  const worktreeParent = path.dirname(tasksBase);
  try {
    const matches = fs.readdirSync(worktreeParent).filter((e) => e.includes(ticket));
    if (matches.length > 0) {
      const worktree = path.join(worktreeParent, matches[0]);
      // lsof on common DB files inside the worktree
      tryRun(
        `cd "${worktree}" && lsof prisma/*.db 2>/dev/null | head -10 || true`,
        `lsof prisma/*.db in ${matches[0]}`
      );
      // Listening processes on common dev ports
      tryRun(
        `lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E ':3000|:5173|:5432' | head -5 || true`,
        'listening ports'
      );
    }
  } catch {
    /* fail-open */
  }

  return lines.join('\n');
}

function buildDiagnosis(ticket, st, taskDir, debugIdleSec, tddIdleSec, extras = {}) {
  const lines = [
    `ORCHESTRATOR STALL DETECTION — ${ticket}`,
    `Detected at: ${new Date().toISOString()}`,
    `debug.md idle: ${Math.floor(debugIdleSec)}s`,
    `last TDD evidence: ${tddIdleSec === Infinity ? 'never' : Math.floor(tddIdleSec) + 's ago'}`,
  ];

  if (typeof st._tddRetryCount === 'number' && st._tddRetryCount > 0) {
    lines.push(`_tddRetryCount: ${st._tddRetryCount}`);
    lines.push(`_tddRetryReason: ${(st._tddRetryReason || '').slice(0, 200)}`);
    if (st._tddRetryOutputTail) {
      const tail = String(st._tddRetryOutputTail).split('\n').slice(-6).join(' | ');
      lines.push(`Last error tail: ${tail.slice(0, 400)}`);
    }
  }

  if (extras.sameFingerprintCount && extras.sameFingerprintCount > 1) {
    lines.push(
      `🔁 Same error fingerprint ${extras.sameFingerprintCount}× in a row — this is not a code fix, it's environmental or scope.`
    );
  }

  const meta = st.tasksMeta;
  if (meta && Array.isArray(meta.tasks)) {
    const cur = meta.tasks[meta.currentTaskIndex];
    if (cur) {
      lines.push(
        `Current task: ${cur.id} status=${cur.status} (${meta.currentTaskIndex + 1}/${meta.totalTasks})`
      );
    }
  }

  if (extras.diagnosticSnapshot) {
    lines.push('');
    lines.push(
      "Orchestrator-side diagnostic snapshot (what you can't see from inside the worktree):"
    );
    lines.push(extras.diagnosticSnapshot);
  }

  lines.push('');
  lines.push('STOP retrying the same command. Either:');
  lines.push(
    '  1) Fix the actual cause (use the snapshot above — likely conflicting process/port/lock)'
  );
  lines.push('  2) Reply with a one-paragraph blocker report and STOP polling');
  return lines.join('\n');
}

function main() {
  if (TASKS_BASES.length === 0) {
    process.stderr.write(
      'No TASKS_BASE configured. Set $TASKS_BASE, $WORKTREES_BASES, or $WORKTREES_GLOB.\n'
    );
    process.exit(1);
  }

  const report = [];
  const skipped = [];

  for (const TASKS_BASE of TASKS_BASES) {
    if (!fs.existsSync(TASKS_BASE)) continue;
    const entries = fs.readdirSync(TASKS_BASE).filter((e) => /^[A-Z]+-\d+/.test(e));

    for (const ticket of entries) {
      const taskDir = path.join(TASKS_BASE, ticket);
      const statePath = path.join(taskDir, '.work-state.json');
      const st = readJsonSafe(statePath);
      if (!st) {
        skipped.push({ ticket, reason: 'no-state' });
        continue;
      }
      if (st.status === 'completed') {
        skipped.push({ ticket, reason: 'completed' });
        continue;
      }

      const now = Math.floor(Date.now() / 1000);
      // Skip dormant tickets — state hasn't been touched in ACTIVE_WINDOW.
      const stateMtime = statMtime(statePath);
      if (!stateMtime || now - Math.floor(stateMtime) > ACTIVE_WINDOW) {
        skipped.push({
          ticket,
          reason: 'dormant',
          stateAge: stateMtime ? now - Math.floor(stateMtime) : null,
        });
        continue;
      }

      const debugMtime = statMtime(path.join(taskDir, 'debug.md'));
      const debugIdle = debugMtime ? now - Math.floor(debugMtime) : Infinity;
      const tddMtime = latestTddTimestamp(taskDir);
      const tddIdle = tddMtime ? now - tddMtime : Infinity;

      const retryStall =
        typeof st._tddRetryCount === 'number' && st._tddRetryCount >= RETRY_LOOP_THRESHOLD;
      const idleStall = debugIdle > IDLE_HARD_THRESHOLD && tddIdle > IDLE_HARD_THRESHOLD;

      // Fingerprint: detect "same error N times in a row" — even when retry
      // count is climbing because the agent thinks it's making progress.
      const fingerprint = computeFingerprint(st);
      const { same: sameFpCount } = recordFingerprint(ticket, fingerprint);
      const fingerprintStall = sameFpCount >= FINGERPRINT_LOOP_THRESHOLD;

      const stuck = retryStall || idleStall || fingerprintStall;
      const reason = fingerprintStall
        ? 'fingerprint-loop'
        : retryStall
          ? 'retry-loop'
          : idleStall
            ? 'idle'
            : null;

      const row = {
        ticket,
        tasksBase: TASKS_BASE,
        step: st.currentStep,
        status: st.status,
        idleSec: debugIdle === Infinity ? null : Math.floor(debugIdle),
        tddIdleSec: tddIdle === Infinity ? null : Math.floor(tddIdle),
        retryCount: st._tddRetryCount || 0,
        fingerprint,
        sameFingerprintCount: sameFpCount,
        stuck,
        reason,
      };

      if (stuck) {
        const channel = ticket;
        const diagnosticSnapshot = captureDiagnosticSnapshot(ticket, TASKS_BASE);
        row.diagnosticSnapshot = diagnosticSnapshot;
        row.nextAction = {
          type: 'nudge-agent',
          channel,
          howToSend: `node ${COMMUNICATE_SCRIPT} ${channel} "<message>"`,
          howToListen: `node ${LISTEN_SCRIPT} ${channel}`,
          suggestedMessage: buildDiagnosis(ticket, st, taskDir, debugIdle, tddIdle, {
            sameFingerprintCount: sameFpCount,
            diagnosticSnapshot,
          }),
        };
      } else {
        row.nextAction = { type: 'monitor', note: 'No action — continue polling' };
      }

      report.push(row);

      if (stuck && shouldNudge(ticket)) {
        // Capture inbox channel mtime BEFORE sending so next cycle can detect
        // whether the agent responded.
        const inboxDir = process.env.CLAUDE_AGENT_INBOX_DIR || '/tmp/claude-agent-inbox';
        const inboxLog = path.join(inboxDir, `${ticket}.log`);
        const beforeMtime = (() => {
          try {
            return fs.statSync(inboxLog).mtimeMs;
          } catch {
            return 0;
          }
        })();
        const delivered = sendNudge(ticket, row.nextAction.suggestedMessage);
        if (delivered) {
          // Only record cooldown on successful delivery — otherwise the next
          // monitor poll should be free to retry instead of burning the
          // 10-min window after a failed send (network/communicate.js crash).
          recordNudgeSent(ticket);
          row.nudged = true;
          row.nudgeMtimeBefore = beforeMtime;
        } else {
          row.nudged = false;
          row.nudgeSkippedReason = 'delivery-failed';
        }
      } else if (stuck) {
        row.nudged = false;
        row.nudgeSkippedReason = 'cooldown';
      }
    }
  }

  const stuckCount = report.filter((r) => r.stuck).length;
  const summary = {
    ts: new Date().toISOString(),
    activeTickets: report.length,
    stuckCount,
    nudgedThisRun: report.filter((r) => r.nudged === true).length,
    tasksBases: TASKS_BASES,
    communicationProtocol: {
      sendToAgent: `node ${COMMUNICATE_SCRIPT} <TICKET> "<message>"`,
      listenOnChannel: `node ${LISTEN_SCRIPT} <TICKET>`,
      listenAllChannels: `node ${LISTEN_ALL_SCRIPT}`,
      inboxDir: process.env.CLAUDE_AGENT_INBOX_DIR || '/tmp/claude-agent-inbox',
      notes: [
        'Channel names are case-insensitive and uppercased.',
        'One file per channel: <inboxDir>/<CHANNEL>.log',
        'Workers send to MONITOR channel (prefix with ticket ID).',
        'Orchestrator sends to <TICKET> channel.',
        'Per-ticket nudges throttled to once per ' + NUDGE_COOLDOWN + 's by this monitor.',
      ],
    },
    thresholds: {
      idleHardSec: IDLE_HARD_THRESHOLD,
      retryLoopCount: RETRY_LOOP_THRESHOLD,
      fingerprintLoopThreshold: FINGERPRINT_LOOP_THRESHOLD,
      nudgeCooldownSec: NUDGE_COOLDOWN,
      activeWindowSec: ACTIVE_WINDOW,
    },
    report,
    skipped,
  };

  // Append a one-line summary to the log file for history.
  try {
    const stuckIds = report
      .filter((r) => r.stuck)
      .map((r) => r.ticket)
      .join(',');
    const line =
      `${summary.ts} active=${summary.activeTickets} stuck=${stuckCount} ` +
      `nudged=${summary.nudgedThisRun}` +
      (stuckIds ? ` ids=${stuckIds}` : '') +
      '\n';
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    /* fail-open */
  }

  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');

  // Exit non-zero when something is stuck — wrappers/cron can react.
  process.exit(stuckCount > 0 ? 2 : 0);
}

main();
