#!/usr/bin/env node

/**
 * context-monitor.js — PostToolUse hook for /work (GH-313).
 *
 * After each agent-dispatch tool completion (Task/Agent), this advisory hook:
 * 1. Scopes to the active /work session (`.work.pid` marker via
 *    `findRecentWorkMarker`) — a foreign/missing marker or a sub-agent context
 *    is a silent no-op.
 * 2. Reads cumulative context-token usage from the session's own transcript
 *    (`context-usage.readCumulativeUsage`, GH-313 Task 2).
 * 3. Computes the integer percent consumed against the model context limit
 *    (`context-policy`, GH-313 Task 1), honoring `WORK_CONTEXT_LIMIT`.
 * 4. Fires once per newly-crossed warning threshold (default 60/70/80, via
 *    `WORK_CONTEXT_WARN_THRESHOLDS`), tracked in a per-ticket crossed-threshold
 *    ledger (`<TASKS_BASE>/<safeTicketId>/.context-monitor.json`), and emits a
 *    warning through `emit.context('PostToolUse', ...)` naming the active step,
 *    the dispatched agent, and the percent. The highest threshold appends a
 *    commit + fresh-agent recommendation.
 *
 * Fail-open (R6): the hook NEVER blocks a tool call and NEVER throws — any
 * error exits 0 silently via `installFailOpen()`. `WORK_CONTEXT_MONITOR_ENABLED=0`
 * short-circuits to a silent no-op (R9), mirroring `SESSION_GUARD_ENABLED`.
 * Zero runtime dependencies, CommonJS.
 */

const fs = require('fs');
const path = require('path');

const hookCommon = require(path.join(__dirname, '..', 'lib', 'hook-common'));
const policy = require(path.join(__dirname, '..', 'lib', 'context-policy'));
const { readCumulativeUsage } = require(path.join(__dirname, '..', 'lib', 'context-usage'));

hookCommon.installFailOpen();

const LEDGER_FILE = '.context-monitor.json';

/** Sanitize a ticket id for a filesystem path (traversal-safe); raw id on failure. */
function safeTicket(ticket) {
  try {
    return require(path.join(__dirname, '..', '..', 'lib', 'config')).safeTicketId(ticket);
  } catch {
    return ticket;
  }
}

/**
 * Resolve the ticket's active step name from `.work-state.json`.
 * `currentStep` is 1-indexed into ALL_STEPS (mirrors capture-usage.readStateStep).
 * A missing/invalid state file yields 'unknown' rather than dropping the warning.
 */
function readStateStep(tasksBase, ticket) {
  try {
    const statePath = path.join(tasksBase, safeTicket(ticket), '.work-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const { ALL_STEPS } = require(path.join(__dirname, '..', 'step-registry'));
    const num = Number(state && state.currentStep);
    if (Number.isFinite(num) && num >= 1 && num <= ALL_STEPS.length) {
      return ALL_STEPS[num - 1];
    }
  } catch {
    /* missing/corrupt state file */
  }
  return 'unknown';
}

/** Dispatched agent type: subagent_type / agentType input field, else tool name. */
function resolveAgentType(evt) {
  const input = evt.toolInput || {};
  return input.subagent_type || input.agentType || evt.rawToolName || 'unknown';
}

/** Absolute path to a ticket's crossed-threshold ledger (traversal-safe). */
function ledgerPath(tasksBase, ticket) {
  return path.join(tasksBase, safeTicket(ticket), LEDGER_FILE);
}

/** Read the crossed-threshold list; [] for a missing/corrupt/absent ledger. */
function readLedger(tasksBase, ticket) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(tasksBase, ticket), 'utf8'));
    return Array.isArray(parsed && parsed.crossed) ? parsed.crossed : [];
  } catch {
    return [];
  }
}

/** Persist the merged crossed-threshold list, sorted ascending. */
function writeLedger(tasksBase, ticket, crossed) {
  try {
    const sorted = [...new Set(crossed)].sort((a, b) => a - b);
    fs.writeFileSync(ledgerPath(tasksBase, ticket), JSON.stringify({ crossed: sorted }));
  } catch {
    /* fail-open: an unwritable ledger must not break the tool call */
  }
}

/** The context-limit override from WORK_CONTEXT_LIMIT (or undefined). */
function limitOverride() {
  return process.env.WORK_CONTEXT_LIMIT;
}

/**
 * Compute the warning percent + newly-crossed thresholds for a dispatch.
 * @returns {{percent:number, thresholds:number[], newly:number[]}}
 */
function computeCrossings(tokens, evt, alreadyCrossed) {
  const limit = policy.modelContextLimit(evt.agent && evt.agent.type, limitOverride());
  const percent = policy.percentUsed(tokens, limit);
  const thresholds = policy.parseThresholds(process.env.WORK_CONTEXT_WARN_THRESHOLDS);
  const newly = policy.newlyCrossed(percent, thresholds, alreadyCrossed);
  return { percent, thresholds, newly };
}

/** Emit one warning per newly-crossed threshold; the top threshold is critical. */
function emitWarnings(rt, ctx) {
  const { percent, thresholds, newly, step, agent } = ctx;
  const critical = Math.max(...thresholds);
  for (const threshold of newly) {
    rt.emit.context(
      'PostToolUse',
      policy.renderWarning({ percent, step, agent, threshold, isCritical: threshold === critical })
    );
  }
}

function main() {
  // R9: disable switch — silent no-op, hook stays registered.
  if (process.env.WORK_CONTEXT_MONITOR_ENABLED === '0') process.exit(0);

  const hookData = hookCommon.readHookData();
  if (!hookData) process.exit(0);

  const { rt, evt } = hookCommon.normalizePostToolEvent(hookData);

  // R7: never fire inside a sub-agent context.
  if (rt.isSubagentContext(evt)) process.exit(0);

  // Only agent-dispatch completions carry a meaningful post-dispatch checkpoint.
  if (evt.toolKind !== 'agent') process.exit(0);

  // R7: scope to this terminal's active /work session marker.
  const found = hookCommon.findRecentWorkMarker();
  if (!found || !found.marker.ticket) process.exit(0);

  const ticket = found.marker.ticket;
  const tokens = readCumulativeUsage(evt.transcriptPath);

  const alreadyCrossed = readLedger(found.tasksBase, ticket);
  const { percent, thresholds, newly } = computeCrossings(tokens, evt, alreadyCrossed);
  if (newly.length === 0) process.exit(0);

  emitWarnings(rt, {
    percent,
    thresholds,
    newly,
    step: readStateStep(found.tasksBase, ticket),
    agent: resolveAgentType(evt),
  });

  writeLedger(found.tasksBase, ticket, [...alreadyCrossed, ...newly]);
  process.exit(0);
}

main();
