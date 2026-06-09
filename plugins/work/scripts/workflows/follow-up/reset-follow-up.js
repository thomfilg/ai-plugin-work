#!/usr/bin/env node

/**
 * reset-follow-up <TICKET> [--dry-run] [--yes]
 *
 * GH-531 R2: wipe `/follow-up` state for a ticket and re-initialize fresh
 * state, without tripping `protect-state-files`. Invoked through the
 * already-EXEMPT `workflow-engine.js` dispatcher so the standard write-
 * protection hook recognizes the caller.
 *
 * Behavior:
 *   - Validate ticket id against /^[A-Z]+-\d+$/ before any path work.
 *   - Path containment check: refuse to operate outside TASKS_BASE/<ticket>/.
 *   - ENOENT-safe unlink of `.follow-up-state.json` and `follow-up-comments.json`.
 *   - Call `initFreshState(ticketId)` from follow-up-next.js to re-init.
 *   - Append provenance row to `<ticketDir>/.work-actions.json`:
 *       { kind: 'reset-follow-up', ticket, ts, invoker: $USER || 'unknown' }
 *   - Print JSON `{ ok, ticket, removed, reinit }` and exit 0.
 *
 * Flags:
 *   --dry-run   Print what would be unlinked; do not touch disk.
 *   --yes       Skip the "print suggested command + stop" confirm gate.
 *               Without --yes, the command prints a suggested command line
 *               and exits 0 without mutating state.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const libDir = path.join(__dirname, '..', 'lib');
const getConfig = require(path.join(libDir, 'get-config'));

const TICKET_RE = /^[A-Z]+-\d+$/;
const STATE_FILES = ['.follow-up-state.json', 'follow-up-comments.json'];

function parseArgs(argv) {
  const positional = [];
  const flags = { dryRun: false, yes: false };
  for (const a of argv) {
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a.startsWith('-')) {
      // unknown flag — fail loudly so callers learn the contract
      process.stderr.write(`reset-follow-up: unknown flag: ${a}\n`);
      process.exit(1);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function resolveTasksBase() {
  const worktreesBase = getConfig('WORKTREES_BASE') || process.env.WORKTREES_BASE;
  const base = getConfig('TASKS_BASE') || (worktreesBase ? path.join(worktreesBase, 'tasks') : '');
  if (!base) {
    process.stderr.write(
      'reset-follow-up: TASKS_BASE not configured (check .envrc / get-config).\n'
    );
    process.exit(1);
  }
  return base;
}

function assertContained(targetPath, baseDir) {
  const resolved = path.resolve(targetPath);
  const baseResolved = path.resolve(baseDir);
  const rel = path.relative(baseResolved, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    process.stderr.write(`reset-follow-up: refusing to operate outside TASKS_BASE: ${resolved}\n`);
    process.exit(1);
  }
}

function safeUnlink(p) {
  try {
    fs.unlinkSync(p);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

function appendProvenance(ticketDir, ticket) {
  const actionsPath = path.join(ticketDir, '.work-actions.json');
  let rows = [];
  try {
    const raw = fs.readFileSync(actionsPath, 'utf8');
    const parsed = JSON.parse(raw);
    rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.actions) ? parsed.actions : [];
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      rows = [];
    } else {
      // Corrupt file — preserve the existing contents under a timestamped
      // sibling so the audit trail isn't silently dropped, then start fresh.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      try {
        fs.renameSync(actionsPath, `${actionsPath}.corrupt-${stamp}`);
      } catch {
        // best-effort — if rename fails (e.g. file gone between read+rename)
        // we still want the reset to proceed with a fresh provenance row.
      }
      rows = [];
    }
  }
  rows.push({
    kind: 'reset-follow-up',
    ticket,
    ts: new Date().toISOString(),
    invoker: process.env.USER || 'unknown',
  });
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(actionsPath, `${JSON.stringify(rows, null, 2)}\n`);
}

function validateTicket(positional) {
  if (positional.length < 1) {
    process.stderr.write(
      'reset-follow-up: missing <TICKET>. Ticket id must match /^[A-Z]+-\\d+$/.\n'
    );
    return null;
  }
  const ticket = positional[0];
  if (!TICKET_RE.test(ticket)) {
    process.stderr.write(
      `reset-follow-up: invalid ticket id "${ticket}" — must match /^[A-Z]+-\\d+$/.\n`
    );
    return null;
  }
  return ticket;
}

function readPreservedPrNumber(ticketDir) {
  try {
    const raw = fs.readFileSync(path.join(ticketDir, '.follow-up-state.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && parsed.prNumber != null ? parsed.prNumber : null;
  } catch {
    return null;
  }
}

function removeStateFiles(ticketDir, TASKS_BASE, dryRun) {
  const removed = [];
  for (const name of STATE_FILES) {
    const p = path.join(ticketDir, name);
    assertContained(p, TASKS_BASE);
    const exists = fs.existsSync(p);
    if (dryRun) {
      if (exists) removed.push(name);
    } else if (safeUnlink(p)) {
      removed.push(name);
    }
  }
  return removed;
}

function run(argv) {
  const { positional, flags } = parseArgs(argv);

  const ticket = validateTicket(positional);
  if (!ticket) return 1;

  if (!flags.yes && !flags.dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          ticket,
          needsConfirm: true,
          suggested: `node ${path.basename(__filename)} ${ticket} --yes`,
        },
        null,
        2
      )}\n`
    );
    return 0;
  }

  const TASKS_BASE = resolveTasksBase();
  const ticketDir = path.join(TASKS_BASE, ticket);
  assertContained(ticketDir, TASKS_BASE);

  // Preserve the saved PR number across reset (GH-531) so follow-up re-entry
  // can still reach the PR after a cap-blocked cycle.
  const preservedPrNumber = readPreservedPrNumber(ticketDir);
  const removed = removeStateFiles(ticketDir, TASKS_BASE, flags.dryRun);

  if (flags.dryRun) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, ticket, removed, reinit: false, dryRun: true }, null, 2)}\n`
    );
    return 0;
  }

  const { initFreshState } = require(path.join(__dirname, 'follow-up-next.js'));
  initFreshState(ticket, { prNumber: preservedPrNumber });
  appendProvenance(ticketDir, ticket);

  process.stdout.write(`${JSON.stringify({ ok: true, ticket, removed, reinit: true }, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(run(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`reset-follow-up: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

module.exports = { run };
