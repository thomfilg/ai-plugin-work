/**
 * stats.js — read-only `/stats <TICKET_ID|all>` backing script (GH-317 / Task 4).
 *
 * Reports, per ticket, the workflow step position (from `ALL_STEPS` +
 * `stepStatus`), whole-run duration (per-step breakdown rendered `n/a`),
 * retry/loop count (from `checkProgress`), git metrics (commits + numstat vs
 * the base branch), and a `tokens: n/a (requires GH-311)` degradation line.
 * `stats all` aggregates every ticket dir under TASKS_BASE into a compact table.
 *
 * Contract: never throws, never mutates fs/git. State is read via
 * `loadState`/`getStatePath`; config via `getConfig`; output via `report-format`.
 */

'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const getConfig = require('../workflows/lib/get-config');
const { ALL_STEPS } = require('../workflows/work/step-registry');
const { getStatePath } = require('../workflows/work/work-state/core');
const { listTicketDirs } = require('./lib/ticket-dirs');
const { statusLine, metricBlock } = require('./lib/report-format');
const { readStateFile } = require('./lib/state-io');
const { runMain } = require('./lib/cli-runner');

const NA = 'n/a';

/**
 * Compute the current-step position from a work state.
 * @param {object} state - parsed `.work-state.json`.
 * @returns {{ name: string, index: number, total: number, completed: number, remaining: number }}
 */
function computeStepPosition(state) {
  const total = ALL_STEPS.length;
  const idx = Number.isInteger(state.currentStep) ? state.currentStep : 0;
  const name = ALL_STEPS[idx - 1] || 'unknown';
  const stepStatus = state.stepStatus || {};
  const completed = ALL_STEPS.filter((s) => stepStatus[s] === 'completed').length;
  const remaining = total - completed;
  return { name, index: idx, total, completed, remaining };
}

/**
 * Format a millisecond span as `<h>h <m>m` / `<m>m` / `<s>s`.
 * @param {number} ms - elapsed milliseconds (negative/NaN → `n/a`).
 * @returns {string}
 */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return NA;
  const totalMin = Math.floor(ms / 60000);
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (totalMin > 0) return `${minutes}m`;
  return `${Math.floor(ms / 1000)}s`;
}

/**
 * Compute the whole-run duration from `startTime`→`lastUpdate`.
 * @param {object} state
 * @returns {string} formatted duration or `n/a`.
 */
function computeRunDuration(state) {
  const start = Date.parse(state.startTime);
  const end = Date.parse(state.lastUpdate);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return NA;
  return formatDuration(end - start);
}

/**
 * Derive the check→implement retry/loop count from `checkProgress`.
 * @param {object} state
 * @returns {number}
 */
function computeRetries(state) {
  const progress = state.checkProgress || {};
  const value = progress.implement;
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * Sum a `git diff --numstat` payload into added/removed/files totals.
 * @param {string} numstat - raw `git diff --numstat` stdout.
 * @returns {{ added: number, removed: number, files: number }}
 */
function sumNumstat(numstat) {
  let added = 0;
  let removed = 0;
  let files = 0;
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue;
    const [a, r] = line.split('\t');
    added += parseInt(a, 10) || 0;
    removed += parseInt(r, 10) || 0;
    files += 1;
  }
  return { added, removed, files };
}

/**
 * Read git metrics (commits ahead + numstat) for a ticket worktree vs base.
 * Pure read: never mutates the repo. Returns `null` when the worktree is
 * missing or git is unavailable, so the caller can render `n/a`.
 * @param {string} ticket - sanitized ticket id (also the branch name).
 * @returns {{ commits: number, added: number, removed: number, files: number }|null}
 */
function gitMetrics(ticket) {
  const worktreesBase = getConfig('WORKTREES_BASE');
  const repoName = getConfig('REPO_NAME');
  if (!worktreesBase || !repoName) return null;
  const worktree = `${worktreesBase}/${repoName}-${ticket}`;
  if (!fs.existsSync(worktree)) return null;

  const base = getConfig('BASE_BRANCH') || 'main';
  const run = (args) => execFileSync('git', args, { cwd: worktree, encoding: 'utf8' }).trim();

  try {
    const range = `${base}..HEAD`;
    const commits = parseInt(run(['rev-list', '--count', range]), 10) || 0;
    const { added, removed, files } = sumNumstat(run(['diff', '--numstat', range]));
    return { commits, added, removed, files };
  } catch (_err) {
    return null;
  }
}

/**
 * Safely read a ticket's state, distinguishing missing from corrupt.
 * @param {string} ticket
 * @returns {{ ok: true, state: object } | { ok: false, reason: 'missing'|'corrupt' }}
 */
function readState(ticket) {
  let statePath;
  try {
    statePath = getStatePath(ticket);
  } catch (_err) {
    return { ok: false, reason: 'missing' };
  }
  return readStateFile(statePath);
}

/**
 * Render the full per-ticket report block.
 * @param {string} ticket
 * @param {object} state
 * @returns {string}
 */
function renderTicket(ticket, state) {
  const pos = computeStepPosition(state);
  const git = gitMetrics(ticket);
  const gitValue = git
    ? `${git.commits} commits, +${git.added}/-${git.removed} lines, ${git.files} file(s) changed`
    : NA;

  const lines = [
    statusLine({ status: 'PASS', label: ticket, detail: `step ${pos.name}` }),
    metricBlock([
      ['Step', `${pos.name} (${pos.index}/${pos.total})`],
      ['Steps completed', String(pos.completed)],
      ['Steps remaining', String(pos.remaining)],
      ['Run duration', computeRunDuration(state)],
      ['Per-step duration', NA],
      ['Retries', `${computeRetries(state)} (check->implement loop)`],
      ['Git', gitValue],
      ['Tokens', `${NA} (requires GH-311)`],
    ]),
  ];
  return lines.join('\n');
}

/**
 * Render the `all` aggregation table (one row per ticket dir).
 * @param {string[]} tickets
 * @returns {string}
 */
function renderAllTable(tickets) {
  const rows = tickets.map((ticket) => {
    const read = readState(ticket);
    if (!read.ok) {
      const note = read.reason === 'corrupt' ? 'unreadable state' : 'no .work-state.json';
      return `  ${ticket}  ${note}`;
    }
    const pos = computeStepPosition(read.state);
    return `  ${ticket}  ${pos.name} (${pos.index}/${pos.total})  retries=${computeRetries(read.state)}`;
  });
  return ['Ticket  Step  Retries', ...rows].join('\n');
}

/**
 * Entry point.
 * @param {string[]} argv - CLI args (excluding node + script).
 * @returns {number} process exit code.
 */
function main(argv) {
  const target = argv[0];
  if (!target) {
    process.stderr.write(
      `${statusLine({ status: 'FAIL', label: 'usage', detail: 'stats <TICKET_ID|all>' })}\n`
    );
    return 1;
  }

  if (target === 'all') {
    const tickets = listTicketDirs();
    process.stdout.write(`${renderAllTable(tickets)}\n`);
    return 0;
  }

  const read = readState(target);
  if (!read.ok) {
    if (read.reason === 'corrupt') {
      process.stdout.write(
        `${statusLine({ status: 'FAIL', label: 'unreadable state', detail: target })}\n`
      );
    } else {
      process.stdout.write(
        `${statusLine({ status: 'FAIL', label: `no .work-state.json for ${target}` })}\n`
      );
    }
    return 1;
  }

  process.stdout.write(`${renderTicket(target, read.state)}\n`);
  return 0;
}

if (require.main === module) {
  runMain(main);
}

module.exports = {
  computeStepPosition,
  computeRunDuration,
  computeRetries,
  gitMetrics,
  formatDuration,
  main,
};
