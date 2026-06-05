#!/usr/bin/env node
// maestro-cleanup.js — purge daemon state so the orchestrator doesn't have to
// ask permission to `rm` markers / kill tmux every time an agent gets stuck.
//
// Usage:
//   node maestro-cleanup.js <TICKET> [--tmux] [--alert-counts]
//   node maestro-cleanup.js --all  [--tmux] [--alert-counts]
//   node maestro-cleanup.js --list
//
// Flags:
//   --tmux           also kill <TICKET>-work and <TICKET>-listen tmux sessions
//   --alert-counts   purge entries for the ticket from _alert-counts.json
//                    (or wipe the whole file when used with --all)
//   --dry-run        print what would be deleted without touching anything
//
// Always idempotent: missing files / sessions are not errors.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Honor STATE_DIR (matches state.js / alerts.js) so custom deployments clean
// the same directory the daemon writes to. MAESTRO_STATE_DIR kept as a legacy
// fallback for any existing callers.
const STATE_DIR =
  process.env.STATE_DIR ||
  process.env.MAESTRO_STATE_DIR ||
  path.join(process.env.HOME || '/tmp', '.cache', 'maestro-conduct');
const ALERT_COUNTS = path.join(STATE_DIR, '_alert-counts.json');

function usage(code = 1) {
  process.stderr.write(
    `usage:\n` +
      `  maestro-cleanup <TICKET> [--tmux] [--alert-counts] [--dry-run]\n` +
      `  maestro-cleanup --all      [--tmux] [--alert-counts] [--dry-run]\n` +
      `  maestro-cleanup --list\n`
  );
  process.exit(code);
}

function listMarkers() {
  if (!fs.existsSync(STATE_DIR)) {
    process.stdout.write(`(no STATE_DIR at ${STATE_DIR})\n`);
    return;
  }
  const tickets = new Map();
  for (const entry of fs.readdirSync(STATE_DIR)) {
    if (entry.startsWith('_')) continue;
    const m = entry.match(/^([A-Z]+-\d+)/);
    if (!m) continue;
    const id = m[1];
    tickets.set(id, (tickets.get(id) || 0) + 1);
  }
  if (tickets.size === 0) {
    process.stdout.write('(no per-ticket markers)\n');
    return;
  }
  for (const [id, n] of [...tickets].sort()) {
    process.stdout.write(`${id}: ${n} marker file(s)\n`);
  }
  if (fs.existsSync(ALERT_COUNTS)) {
    try {
      const counts = JSON.parse(fs.readFileSync(ALERT_COUNTS, 'utf8'));
      process.stdout.write(`_alert-counts.json: ${Object.keys(counts).length} key(s)\n`);
    } catch {
      process.stdout.write(`_alert-counts.json: (unparseable)\n`);
    }
  }
}

// Escape regex metacharacters in user-supplied input so a ticket like
// "GH-1.*" can't widen the marker-match pattern (CodeQL js/regex-injection).
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markersForTicket(ticket) {
  if (!fs.existsSync(STATE_DIR)) return [];
  const prefix = `${ticket}`;
  const tickRe = new RegExp(`^${escapeRegex(ticket)}(-(work|listen|dev))?\\.[^/]+\\.json$`);
  return fs
    .readdirSync(STATE_DIR)
    .filter((name) => name.startsWith(prefix) && tickRe.test(name))
    .map((name) => path.join(STATE_DIR, name));
}

function allTicketMarkers() {
  if (!fs.existsSync(STATE_DIR)) return [];
  return fs
    .readdirSync(STATE_DIR)
    .filter((name) => !name.startsWith('_') && name.endsWith('.json'))
    .map((name) => path.join(STATE_DIR, name));
}

function deleteFiles(files, dryRun) {
  let removed = 0;
  for (const f of files) {
    if (dryRun) {
      process.stdout.write(`(dry-run) would remove ${f}\n`);
      continue;
    }
    try {
      fs.unlinkSync(f);
      removed += 1;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        process.stderr.write(`warn: failed to remove ${f}: ${err.message}\n`);
      }
    }
  }
  return removed;
}

function killTmux(ticket, dryRun) {
  let killed = 0;
  for (const suffix of ['work', 'listen']) {
    const session = `${ticket}-${suffix}`;
    if (dryRun) {
      process.stdout.write(`(dry-run) would tmux kill-session -t ${session}\n`);
      continue;
    }
    const res = spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' });
    if (res.status === 0) killed += 1;
  }
  return killed;
}

function killAllTmuxFromMarkers(dryRun) {
  const tickets = new Set();
  for (const f of allTicketMarkers()) {
    const m = path.basename(f).match(/^([A-Z]+-\d+)/);
    if (m) tickets.add(m[1]);
  }
  let killed = 0;
  for (const t of tickets) killed += killTmux(t, dryRun);
  return killed;
}

function wipeAllAlertCounts(dryRun) {
  if (dryRun) {
    process.stdout.write(`(dry-run) would wipe ${ALERT_COUNTS}\n`);
    return 0;
  }
  // Avoid TOCTOU: try-unlink and treat ENOENT as "already gone" instead of
  // checking existence first (CodeQL js/file-system-race).
  try {
    fs.unlinkSync(ALERT_COUNTS);
    return 1;
  } catch (err) {
    if (err && err.code === 'ENOENT') return 0;
    throw err;
  }
}

function purgeAlertCountsForTicket(ticket, dryRun) {
  let counts;
  try {
    counts = JSON.parse(fs.readFileSync(ALERT_COUNTS, 'utf8'));
  } catch {
    return 0;
  }
  // Alert keys are `${session}|${kind}|${sha-or-phase}` where session is
  // typically `${ticket}` or `${ticket}-work` / `${ticket}-listen` etc.
  // A substring match would purge counts for GH-10/GH-11 when cleaning GH-1,
  // so anchor on the ticket boundary: ticket followed by `|` (session==ticket)
  // or `-...|` (session==`${ticket}-suffix`).
  const tickRe = new RegExp(`^${escapeRegex(ticket)}(-[^|]*)?\\|`);
  let removed = 0;
  for (const key of Object.keys(counts)) {
    if (tickRe.test(key)) {
      if (!dryRun) delete counts[key];
      removed += 1;
    }
  }
  if (!dryRun && removed > 0) {
    fs.writeFileSync(ALERT_COUNTS, JSON.stringify(counts, null, 2));
  } else if (dryRun) {
    process.stdout.write(`(dry-run) would purge ${removed} key(s) for ${ticket} from _alert-counts.json\n`);
  }
  return removed;
}

function purgeAlertCounts(ticket, dryRun) {
  // No existence pre-check; the inner functions handle a missing file via
  // their read/unlink try/catch. Avoids TOCTOU between check and use
  // (CodeQL js/file-system-race).
  if (!ticket) return wipeAllAlertCounts(dryRun);
  return purgeAlertCountsForTicket(ticket, dryRun);
}

function runAllMode({ dryRun, wantTmux, wantAlertCounts }) {
  const files = allTicketMarkers();
  const removed = deleteFiles(files, dryRun);
  const killedTmux = wantTmux ? killAllTmuxFromMarkers(dryRun) : 0;
  const wipedCounts = wantAlertCounts ? purgeAlertCounts(null, dryRun) : 0;
  process.stdout.write(
    `cleanup --all: removed ${removed} marker(s)` +
      (wantTmux ? `, killed ${killedTmux} tmux session(s)` : '') +
      (wantAlertCounts ? `, alert-counts wiped=${wipedCounts}` : '') +
      '\n'
  );
}

function runTicketMode({ ticket, dryRun, wantTmux, wantAlertCounts }) {
  if (!/^[A-Z]+-\d+$/.test(ticket)) {
    process.stderr.write(`error: ticket "${ticket}" must match /^[A-Z]+-\\d+$/\n`);
    process.exit(1);
  }
  const files = markersForTicket(ticket);
  const removed = deleteFiles(files, dryRun);
  const killedTmux = wantTmux ? killTmux(ticket, dryRun) : 0;
  const purgedCounts = wantAlertCounts ? purgeAlertCounts(ticket, dryRun) : 0;
  process.stdout.write(
    `cleanup ${ticket}: removed ${removed} marker(s)` +
      (wantTmux ? `, killed ${killedTmux} tmux session(s)` : '') +
      (wantAlertCounts ? `, purged ${purgedCounts} alert-count key(s)` : '') +
      '\n'
  );
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  if (args.includes('--list')) {
    listMarkers();
    return;
  }

  const flags = {
    dryRun: args.includes('--dry-run'),
    wantTmux: args.includes('--tmux'),
    wantAlertCounts: args.includes('--alert-counts'),
  };
  const positional = args.filter((a) => !a.startsWith('--'));

  if (args.includes('--all')) {
    runAllMode(flags);
    return;
  }

  if (positional.length !== 1) usage();
  runTicketMode({ ticket: positional[0], ...flags });
}

if (require.main === module) {
  main();
}

module.exports = { purgeAlertCountsForTicket };
