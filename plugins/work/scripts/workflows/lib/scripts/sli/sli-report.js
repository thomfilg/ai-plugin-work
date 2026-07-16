#!/usr/bin/env node

'use strict';

/**
 * sli-report.js — implement-phase SLI extractor (GH-751, outcome-verification
 * Phase 0; plan §6 Phase 0 / §7).
 *
 * Reads each `<ticket>/` dir under a tasks base and derives, per ticket and in
 * aggregate, the SLIs the outcome-verification work is judged against: wedge
 * rate, escape rate, retries/task, dispatches, time-in-implement. All
 * heuristics are documented proxies over the audit trail — run --help.
 *
 * Usage:
 *   node sli-report.js [--tasks-base <dir>] [--wedge-threshold <n>] [--json]
 *                      [ticket ...]
 *
 * Contract: read-only, standalone (TASKS_BASE env or --tasks-base); exit 0
 * with warnings on bad per-ticket data; exit 1 only on unusable input.
 */

const {
  ACTIONS_FILE,
  STATE_FILE,
  DEFAULT_WEDGE_THRESHOLD,
  listTicketDirs,
  analyzeTicket,
} = require('./scan');
const { formatDuration } = require('../../../../stats/stats');

/** Aggregate the per-ticket reports. */
function aggregate(reports) {
  const agg = {
    tickets: reports.length,
    ticketsWithWedge: 0,
    ticketsWithEscape: 0,
    tasksKnown: 0,
    tasksAdvanced: 0,
    tasksWedged: 0,
    tasksEscaped: 0,
    retriesTotal: 0,
    dispatchesTotal: 0,
    implementDispatchesTotal: 0,
    timeInImplementMsTotal: 0,
    implementReentriesTotal: 0,
    wedgeRate: 0,
    escapeRate: 0,
  };
  for (const r of reports) {
    if (r.wedgedTasks.length > 0 || r.unattributedRecoveries > 0) agg.ticketsWithWedge++;
    if (r.escapedTasks.length > 0 || r.implementReentries > 0) agg.ticketsWithEscape++;
    agg.tasksKnown += r.knownTasks;
    agg.tasksAdvanced += r.advancedTasks.length;
    agg.tasksWedged += r.wedgedTasks.length;
    agg.tasksEscaped += r.escapedTasks.length;
    agg.retriesTotal += r.retriesTotal;
    agg.dispatchesTotal += r.dispatches.usageRows;
    agg.implementDispatchesTotal += r.dispatches.implement;
    agg.timeInImplementMsTotal += r.timeInImplementMs;
    agg.implementReentriesTotal += r.implementReentries;
  }
  agg.wedgeRate = agg.tasksKnown > 0 ? agg.tasksWedged / agg.tasksKnown : 0;
  agg.escapeRate = agg.tasksAdvanced > 0 ? agg.tasksEscaped / agg.tasksAdvanced : 0;
  return agg;
}

const HELP = `sli-report — implement-phase SLI extractor (outcome-verification Phase 0)

Usage:
  node sli-report.js [options] [ticket ...]

Options:
  --tasks-base <dir>       Tasks base dir containing <ticket>/ dirs with
                           ${ACTIONS_FILE} + ${STATE_FILE}.
                           Default: $TASKS_BASE.
  --wedge-threshold <n>    Retries-per-task count ABOVE which a task counts as
                           wedged (default ${DEFAULT_WEDGE_THRESHOLD}).
  --json                   Machine output (single JSON document on stdout).
  -h, --help               This help.

Positional ticket ids restrict the report to those ticket dirs.

Measurement heuristics (all SLIs are proxies over the audit trail — escape
attribution in particular is heuristic):

  Wedge (per task) — any of:
    W1 retries(task) > threshold, where retries(task) =
       taskReviewFixRounds (state) + max(gate-rejection enforcement rows
       [action tdd-*, allow:false] attributed to the task, _tddRetryCount
       attributed via _tddRetryTask). max() avoids double-counting: a gate
       rejection writes an enforcement row AND bumps _tddRetryCount.
    W2 escalation row: "task N/M fix rounds exhausted ... escalating".
    W3 operator recovery/surgery event: legacy what/meta.type matching
       /recover|surgery/i or enforcement action matching /recover/i
       ('work-state.js recover' rows land here). Unattributed events attach
       to the state's current task, else count at ticket level only.
    W4 planner hold parked in state (_tddRetryPlannerDefect via _tddRetryTask).

  Escape (per task) — advanced AND caught defective downstream:
    E1 advanced: tasksMeta status 'completed' OR any "task N/M review
       scheduled" row (task_review only runs after the gate advanced it).
    E2 defect signal: "task review failed: ..." row attributed to the task
       via the nearest PRECEDING "review scheduled" row (the failure row
       carries no task number), OR taskReviewFixRounds > 0.
    E3 ticket-level only: implement re-entries (implement 'step started'
       rows beyond the first) mean a downstream step sent the workflow back;
       reported as implementReentries without naming a task.

  Dispatches:
    D1 per ticket: usage rows (kind:'usage'); implementDispatches = those
       with step 'implement'.
    D2 per task: "review scheduled" rows per task (orchestrator passes —
       over-counts agent dispatches; only per-task-attributable signal).

  Time-in-implement:
    T1 sum of implement-step 'step started' -> 'step completed' intervals;
       a dangling start closes at the last legacy row timestamp.

Rates:
  wedge rate  = wedged tasks / known tasks
  escape rate = escaped tasks / advanced tasks
`;

/** Apply one value-taking flag. Returns an error string or null. */
function consumeValueFlag(out, flag, value) {
  if (flag === '--tasks-base') {
    if (!value) return '--tasks-base requires a directory argument';
    out.tasksBase = value;
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return '--wedge-threshold requires a non-negative integer';
  }
  out.wedgeThreshold = parsed;
  return null;
}

/** Parse CLI args. Returns { help, json, tasksBase, wedgeThreshold, tickets, error }. */
function parseArgs(argv, env) {
  const out = {
    help: false,
    json: false,
    tasksBase: env.TASKS_BASE || null,
    wedgeThreshold: DEFAULT_WEDGE_THRESHOLD,
    tickets: [],
    error: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      out.help = true;
      continue;
    }
    if (arg === '--json') {
      out.json = true;
      continue;
    }
    if (arg === '--tasks-base' || arg === '--wedge-threshold') {
      const error = consumeValueFlag(out, arg, argv[++i]);
      if (error) return { ...out, error };
      continue;
    }
    if (arg.startsWith('-')) return { ...out, error: `unknown option: ${arg}` };
    out.tickets.push(arg);
  }
  return out;
}

/** Format a 0..1 rate as a percentage. */
function pct(rate) {
  return `${(rate * 100).toFixed(1)}%`;
}

/** Render the human table. */
function renderTable(reports, agg, options) {
  const header = [
    'ticket',
    'tasks',
    'advanced',
    'wedged',
    'escaped',
    'retries',
    'disp',
    'impl-time',
  ];
  const rows = reports.map((r) => [
    r.ticket,
    String(r.knownTasks),
    String(r.advancedTasks.length),
    r.wedgedTasks.length > 0 ? `${r.wedgedTasks.length} (#${r.wedgedTasks.join(',#')})` : '0',
    r.escapedTasks.length > 0 ? `${r.escapedTasks.length} (#${r.escapedTasks.join(',#')})` : '0',
    String(r.retriesTotal),
    String(r.dispatches.usageRows),
    formatDuration(r.timeInImplementMs),
  ]);
  const widths = header.map((h, col) => Math.max(h.length, ...rows.map((row) => row[col].length)));
  const renderRow = (cells) => cells.map((c, col) => c.padEnd(widths[col])).join('  ');

  const lines = [renderRow(header), renderRow(widths.map((w) => '-'.repeat(w)))];
  for (const row of rows) lines.push(renderRow(row));
  lines.push('');
  lines.push(
    `aggregate: ${agg.tickets} ticket(s), ${agg.tasksKnown} task(s), ` +
      `wedge rate ${pct(agg.wedgeRate)} (${agg.tasksWedged}/${agg.tasksKnown} tasks, ` +
      `${agg.ticketsWithWedge} ticket(s)), ` +
      `escape rate ${pct(agg.escapeRate)} (${agg.tasksEscaped}/${agg.tasksAdvanced} advanced, ` +
      `${agg.ticketsWithEscape} ticket(s))`
  );
  lines.push(
    `           retries ${agg.retriesTotal}, dispatches ${agg.dispatchesTotal} ` +
      `(${agg.implementDispatchesTotal} implement), ` +
      `time-in-implement ${formatDuration(agg.timeInImplementMsTotal)}, ` +
      `implement re-entries ${agg.implementReentriesTotal}, ` +
      `wedge threshold ${options.wedgeThreshold}`
  );
  return lines.join('\n');
}

/** Collect per-ticket reports, folding failures into warnings. */
function collectReports(requested, options, warnings) {
  const reports = [];
  for (const ticket of requested) {
    let result;
    try {
      result = analyzeTicket(options.tasksBase, ticket, options);
    } catch (err) {
      // Belt-and-braces: analyzeTicket is designed never to throw, but a
      // measurement tool must never crash on one bad ticket dir.
      warnings.push(`${ticket}: analysis failed (${err && err.message}) — skipped`);
      continue;
    }
    warnings.push(...result.warnings);
    if (!result.skipped) reports.push(result);
  }
  return reports;
}

/** Entry point. @returns {number} exit code */
function main(argv, env, stdout, stderr) {
  const options = parseArgs(argv, env);
  if (options.error) {
    stderr.write(`error: ${options.error}\n\n${HELP}`);
    return 1;
  }
  if (options.help) {
    stdout.write(HELP);
    return 0;
  }
  if (!options.tasksBase) {
    stderr.write('error: no tasks base — set TASKS_BASE or pass --tasks-base <dir>\n');
    return 1;
  }

  const requested =
    options.tickets.length > 0 ? options.tickets : listTicketDirs(options.tasksBase);
  if (requested === null) {
    stderr.write(`error: cannot read tasks base dir: ${options.tasksBase}\n`);
    return 1;
  }

  const warnings = [];
  const reports = collectReports(requested, options, warnings);
  for (const warning of warnings) stderr.write(`warning: ${warning}\n`);

  const agg = aggregate(reports);
  if (options.json) {
    const doc = {
      generatedAt: new Date().toISOString(),
      tasksBase: options.tasksBase,
      wedgeThreshold: options.wedgeThreshold,
      tickets: reports,
      aggregate: agg,
      warnings,
    };
    stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
    return 0;
  }
  if (reports.length === 0) {
    stdout.write(`no analyzable tickets under ${options.tasksBase}\n`);
    return 0;
  }
  stdout.write(`${renderTable(reports, agg, options)}\n`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), process.env, process.stdout, process.stderr);
}

module.exports = { parseArgs, renderTable, aggregate, main };
