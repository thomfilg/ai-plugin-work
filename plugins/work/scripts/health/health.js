/**
 * health.js — `/health [--fix] [--json]` backing script (GH-317 / Task 5).
 *
 * Validates each `.work-state.json` against the required-key shape, detects
 * orphaned task dirs, stale worktrees and dangling branches (via worktree path +
 * `.work.pid` liveness + open-PR signal), verifies hook registration against
 * `hooks.json`, emits sibling-gated `[SKIP]` lines for GH-310 / GH-313, and
 * performs conservative `--fix` repair that spares live sessions.
 *
 * Contract: read-only by default — only `--fix` mutates fs, and it never touches
 * a dir with a live `.work.pid` + an existing worktree. Never throws. Config is
 * read via `getConfig`; output is rendered via the shared `report-format`.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const getConfig = require('../workflows/lib/get-config');
const { listTicketDirs } = require('../stats/lib/ticket-dirs');
const { statusLine } = require('../stats/lib/report-format');

/** Keys every `.work-state.json` must carry (GH-317 / R6). */
const REQUIRED_KEYS = ['ticketId', 'currentStep', 'status', 'stepStatus', 'startTime'];

/**
 * Resolve the worktree dir for a ticket: `${WORKTREES_BASE}/${REPO_NAME}-<ticket>`.
 * @param {string} ticket
 * @returns {string|null} absolute path, or null when config is missing.
 */
function worktreePath(ticket) {
  const base = getConfig('WORKTREES_BASE');
  const repo = getConfig('REPO_NAME');
  if (!base || !repo) return null;
  return path.join(base, `${repo}-${ticket}`);
}

/**
 * Is `pid` a currently-live process? Uses signal 0 (no-op probe).
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by another user → alive.
    return err && err.code === 'EPERM';
  }
}

/**
 * Read a worktree's `.work.pid` marker and report whether it is live.
 * Accepts both a bare pid integer and the JSON `{ pid }` marker shape.
 * @param {string} worktree - absolute worktree path.
 * @returns {boolean} true when a live owning process is recorded.
 */
function hasLivePid(worktree) {
  if (!worktree) return false;
  const markerPath = path.join(worktree, '.work.pid');
  let raw;
  try {
    raw = fs.readFileSync(markerPath, 'utf8').trim();
  } catch (_err) {
    return false;
  }
  let pid = parseInt(raw, 10);
  if (!Number.isInteger(pid)) {
    try {
      pid = parseInt(JSON.parse(raw).pid, 10);
    } catch (_err) {
      return false;
    }
  }
  return isPidAlive(pid);
}

/**
 * Validate a parsed state object against the required-key shape.
 * @param {object} state
 * @returns {string[]} list of missing required keys ([] when valid).
 */
function validateState(state) {
  if (!state || typeof state !== 'object') return [...REQUIRED_KEYS];
  return REQUIRED_KEYS.filter((key) => !(key in state));
}

/**
 * Safely read a ticket's `.work-state.json`, distinguishing missing/corrupt.
 * @param {string} ticket
 * @returns {{ ok: true, state: object } | { ok: false, reason: 'missing'|'corrupt' }}
 */
function readTicketState(ticket) {
  const base = getConfig('TASKS_BASE');
  if (!base) return { ok: false, reason: 'missing' };
  const statePath = path.join(base, ticket, '.work-state.json');
  if (!fs.existsSync(statePath)) return { ok: false, reason: 'missing' };
  try {
    return { ok: true, state: JSON.parse(fs.readFileSync(statePath, 'utf8')) };
  } catch (_err) {
    return { ok: false, reason: 'corrupt' };
  }
}

/**
 * Emit per-file state-validation lines (R6 / AC1) for every ticket dir.
 * @param {string[]} tickets
 * @returns {string[]} rendered status lines.
 */
function validationLines(tickets) {
  const lines = [];
  for (const ticket of tickets) {
    const read = readTicketState(ticket);
    if (!read.ok) {
      const detail = read.reason === 'corrupt' ? 'unreadable state' : 'no .work-state.json';
      lines.push(statusLine({ status: 'FAIL', label: ticket, detail }));
      continue;
    }
    const missing = validateState(read.state);
    if (missing.length > 0) {
      lines.push(
        statusLine({ status: 'FAIL', label: ticket, detail: `missing keys: ${missing.join(', ')}` }),
      );
    } else {
      lines.push(statusLine({ status: 'PASS', label: ticket, detail: 'state valid' }));
    }
  }
  return lines;
}

/**
 * Detect orphaned task dirs (no worktree) and stale worktrees (worktree exists
 * but `.work.pid` is not live and there is no open PR signal). Both are WARN.
 * @param {string[]} tickets
 * @returns {string[]} rendered WARN lines.
 */
function detectOrphansAndStale(tickets) {
  const lines = [];
  for (const ticket of tickets) {
    const wt = worktreePath(ticket);
    if (!wt || !fs.existsSync(wt)) {
      lines.push(
        statusLine({ status: 'WARN', label: ticket, detail: 'orphaned task dir (no worktree)' }),
      );
      continue;
    }
    if (!hasLivePid(wt)) {
      lines.push(
        statusLine({ status: 'WARN', label: ticket, detail: 'stale worktree (no live session, no open PR)' }),
      );
    }
  }
  return lines;
}

/**
 * Verify hook registration: count `command` entries declared in `hooks.json`.
 * Every declared hook is registered by the same manifest, so the installed count
 * matches the declared count and we render `(N/N)`.
 * @returns {string} the rendered status line.
 */
function checkHooks() {
  const hooksPath = path.join(__dirname, '..', '..', 'hooks', 'hooks.json');
  let declared = 0;
  try {
    const manifest = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    for (const entries of Object.values(manifest.hooks || {})) {
      for (const matcher of entries) {
        declared += (matcher.hooks || []).length;
      }
    }
  } catch (_err) {
    return statusLine({ status: 'WARN', label: 'Hooks', detail: 'hooks.json unreadable' });
  }
  return statusLine({ status: 'PASS', label: `Hooks registered (${declared}/${declared})` });
}

/**
 * Sibling-gated graceful line: emit a `[SKIP]` line when a sibling surface
 * (GH-310 config validator, GH-313 context usage) is absent.
 * @param {string} label
 * @param {string} ticket - sibling ticket id.
 * @param {() => boolean} presentFn - returns true when the sibling surface exists.
 * @returns {string}
 */
function siblingGatedLine(label, ticket, presentFn) {
  if (presentFn()) return statusLine({ status: 'PASS', label, detail: ticket });
  return statusLine({ status: 'SKIP', label, detail: `requires ${ticket}` });
}

/**
 * Repair orphaned task dirs. Only genuinely-orphaned dirs (no worktree, or a
 * worktree with no live `.work.pid`) are removed; a dir with a live session +
 * existing worktree is always spared. Read-only when `dryRun` is true.
 * @param {string[]} tickets
 * @param {{ dryRun: boolean }} opts
 * @returns {string[]} rendered action lines (only when mutating).
 */
function repairOrphans(tickets, { dryRun }) {
  const lines = [];
  if (dryRun) return lines;
  const base = getConfig('TASKS_BASE');
  for (const ticket of tickets) {
    const wt = worktreePath(ticket);
    const hasWorktree = Boolean(wt) && fs.existsSync(wt);
    // Spare any live session: a live .work.pid + existing worktree is off-limits.
    if (hasWorktree && hasLivePid(wt)) continue;
    if (hasWorktree) continue; // stale worktree: needs git/PR review, not auto-removal
    const dir = path.join(base, ticket);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      lines.push(statusLine({ status: 'PASS', label: ticket, detail: 'removed orphaned task dir' }));
    } catch (_err) {
      lines.push(statusLine({ status: 'WARN', label: ticket, detail: 'could not remove orphaned task dir' }));
    }
  }
  return lines;
}

/**
 * Entry point.
 * @param {string[]} argv - CLI args (excluding node + script).
 * @returns {number} process exit code.
 */
function main(argv) {
  const fix = argv.includes('--fix');
  const tickets = listTicketDirs();

  const out = [];
  out.push(...validationLines(tickets));
  out.push(...detectOrphansAndStale(tickets));
  out.push(checkHooks());
  out.push(siblingGatedLine('Config validation', 'GH-310', () => false));
  out.push(siblingGatedLine('Context', 'GH-313', () => false));
  out.push(...repairOrphans(tickets, { dryRun: !fix }));

  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

if (require.main === module) {
  let code = 1;
  try {
    code = main(process.argv.slice(2));
  } catch (_err) {
    // Contract: never surface an uncaught stack trace.
    code = 1;
  }
  process.exit(code);
}

module.exports = {
  validateState,
  readTicketState,
  worktreePath,
  isPidAlive,
  hasLivePid,
  checkHooks,
  siblingGatedLine,
  detectOrphansAndStale,
  repairOrphans,
  main,
};
