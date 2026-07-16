'use strict';

/**
 * scan.js — per-ticket SLI analysis for sli-report.js (GH-751, Phase 0).
 *
 * Folds a ticket dir's `.work-actions.json` (append-only audit trail; legacy /
 * enforcement / usage row shapes coexist) and `.work-state.json` (tasksMeta,
 * `_tddRetry*` gate-retry fields) into per-task wedge/escape verdicts and
 * ticket-level counters. Every SLI is a documented PROXY over what the trail
 * actually records — see HELP in sli-report.js for the full heuristics list
 * (W1–W4 wedge, E1–E3 escape, D1–D2 dispatch, T1 time-in-implement).
 *
 * Contract: read-only; never throws on per-ticket data — malformed inputs
 * degrade to warnings.
 */

const fs = require('node:fs');
const path = require('node:path');

const ACTIONS_FILE = '.work-actions.json';
const STATE_FILE = '.work-state.json';
const DEFAULT_WEDGE_THRESHOLD = 3;

const REVIEW_SCHEDULED_RE = /^task (\d+)\/(\d+) review scheduled\b/;
const REVIEW_FAILED_RE = /^task review failed\b/;
const REVIEW_PASSED_RE = /^task review passed\b/;
const ESCALATED_RE = /^task (\d+)\/(\d+) fix rounds exhausted\b/;
const RECOVERY_WHAT_RE = /\brecover(?:y|ed|ing)?\b|\bsurgery\b/i;
const RECOVERY_TYPE_RE = /recover|surgery/i;
const RECOVERY_ACTION_RE = /recover/i;
const GATE_REJECTION_ACTION_RE = /^tdd-/;

/**
 * Read + parse a JSON file. Never throws.
 * @returns {{ ok: true, data: * } | { ok: false, reason: 'missing'|'malformed' }}
 */
function readJsonFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { ok: false, reason: 'missing' };
  }
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

/** List direct-child ticket dir names under the base. Never throws. */
function listTicketDirs(tasksBase) {
  let dirents;
  try {
    dirents = fs.readdirSync(tasksBase, { withFileTypes: true });
  } catch {
    return null;
  }
  return dirents
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .map((d) => d.name)
    .filter((name) => !name.includes('/') && !name.includes('..'))
    .sort();
}

/** Timestamp → epoch ms, or null when unparseable. */
function ts(row) {
  const value = Date.parse(row && row.timestamp);
  return Number.isFinite(value) ? value : null;
}

/** Lazily create the per-task accumulator bucket. */
function taskBucket(perTask, taskNum) {
  if (!perTask.has(taskNum)) {
    perTask.set(taskNum, {
      task: taskNum,
      gateRejections: 0,
      fixRounds: 0,
      stateRetries: 0,
      reviewFailures: 0,
      reviewPasses: 0,
      orchestratorPasses: 0,
      escalations: 0,
      recoveries: 0,
      plannerHold: false,
      completed: false,
      advanced: false,
      retries: 0,
      wedged: false,
      escaped: false,
    });
  }
  return perTask.get(taskNum);
}

/** Is this legacy/enforcement row an operator recovery/surgery event (W3)? */
function isRecoveryRow(row) {
  if (row.kind === 'enforcement') {
    return RECOVERY_ACTION_RE.test(String(row.action || ''));
  }
  if (row.kind) return false; // usage rows never are
  const what = String(row.what || '');
  const metaType = row.meta && row.meta.type ? String(row.meta.type) : '';
  return RECOVERY_WHAT_RE.test(what) || RECOVERY_TYPE_RE.test(metaType);
}

/** Fold one enforcement row into the accumulators. */
function scanEnforcementRow(row, perTask, signals) {
  if (row.allow === false && GATE_REJECTION_ACTION_RE.test(String(row.action || ''))) {
    const taskNum = Number.parseInt(row.task, 10);
    if (Number.isInteger(taskNum) && taskNum > 0) taskBucket(perTask, taskNum).gateRejections++;
  }
  if (isRecoveryRow(row)) {
    const taskNum = Number.parseInt(row.task, 10);
    if (Number.isInteger(taskNum) && taskNum > 0) taskBucket(perTask, taskNum).recoveries++;
    else signals.unattributedRecoveries++;
  }
}

/** Fold one implement-step legacy row into the T1/re-entry counters. */
function scanImplementRow(what, t, signals, timing) {
  if (what === 'step started') {
    signals.implementStarts++;
    if (t !== null) timing.openedAt = t;
  } else if (what === 'step completed') {
    if (timing.openedAt !== null && t !== null && t >= timing.openedAt) {
      signals.timeInImplementMs += t - timing.openedAt;
    }
    timing.openedAt = null;
  } else if (what === 'step reset') {
    signals.implementStepResets++;
  } else if (what.startsWith('BLOCKED:')) {
    signals.implementBlocks++;
  }
}

/**
 * Fold review/escalation signals from a legacy row's `what` text.
 * @returns {{ handled: boolean, task: number|null }} updated attribution task.
 */
function scanReviewSignals(what, perTask, signals, lastScheduledTask) {
  let match = what.match(REVIEW_SCHEDULED_RE);
  if (match) {
    const taskNum = Number.parseInt(match[1], 10);
    taskBucket(perTask, taskNum).orchestratorPasses++;
    return { handled: true, task: taskNum };
  }
  match = what.match(ESCALATED_RE);
  if (match) {
    taskBucket(perTask, Number.parseInt(match[1], 10)).escalations++;
    return { handled: true, task: lastScheduledTask };
  }
  if (REVIEW_FAILED_RE.test(what)) {
    if (lastScheduledTask !== null) taskBucket(perTask, lastScheduledTask).reviewFailures++;
    else signals.unattributedReviewFailures++;
    return { handled: true, task: lastScheduledTask };
  }
  if (REVIEW_PASSED_RE.test(what)) {
    if (lastScheduledTask !== null) taskBucket(perTask, lastScheduledTask).reviewPasses++;
    return { handled: true, task: lastScheduledTask };
  }
  return { handled: false, task: lastScheduledTask };
}

/** Fold one legacy row into the accumulators. Returns the new lastScheduledTask. */
function scanLegacyRow(row, perTask, signals, timing, lastScheduledTask) {
  const t = ts(row);
  if (t !== null) timing.lastLegacyTs = t;
  const what = String(row.what || '');

  if (row.step === 'implement') scanImplementRow(what, t, signals, timing);

  const review = scanReviewSignals(what, perTask, signals, lastScheduledTask);
  if (review.handled) return review.task;

  if (isRecoveryRow(row)) {
    const metaTask = row.meta ? Number.parseInt(row.meta.task, 10) : Number.NaN;
    if (Number.isInteger(metaTask) && metaTask > 0) taskBucket(perTask, metaTask).recoveries++;
    else signals.unattributedRecoveries++;
  }
  return review.task;
}

/** Fold the actions trail into per-task + ticket-level signals. */
function scanActions(rows, perTask) {
  const signals = {
    usageDispatches: 0,
    implementDispatches: 0,
    implementStarts: 0,
    implementStepResets: 0,
    implementBlocks: 0,
    unattributedRecoveries: 0,
    unattributedReviewFailures: 0,
    timeInImplementMs: 0,
    implementReentries: 0,
  };

  // Chronological order: the trail is append-only, but sort defensively so
  // review-failure attribution (nearest preceding scheduled row) is stable.
  const ordered = rows
    .map((row, i) => ({ row, i, t: ts(row) }))
    .sort((a, b) => (a.t ?? 0) - (b.t ?? 0) || a.i - b.i)
    .map((e) => e.row);

  const timing = { openedAt: null, lastLegacyTs: null };
  let lastScheduledTask = null;

  for (const row of ordered) {
    if (row.kind === 'usage') {
      signals.usageDispatches++;
      if (row.step === 'implement') signals.implementDispatches++;
      continue;
    }
    if (row.kind === 'enforcement') {
      scanEnforcementRow(row, perTask, signals);
      continue;
    }
    if (row.kind) continue; // unknown future kind — ignore
    lastScheduledTask = scanLegacyRow(row, perTask, signals, timing, lastScheduledTask);
  }

  // T1: dangling implement start closes at the last legacy timestamp.
  if (timing.openedAt !== null && timing.lastLegacyTs !== null) {
    if (timing.lastLegacyTs > timing.openedAt) {
      signals.timeInImplementMs += timing.lastLegacyTs - timing.openedAt;
    }
  }
  // E3: every implement re-entry after the first is a downstream step
  // (check / task_review / follow_up) sending the workflow back.
  signals.implementReentries = Math.max(0, signals.implementStarts - 1);
  return signals;
}

/** Fold `_tddRetry*` gate-retry fields into the task buckets (W1/W4). */
function scanRetryState(state, perTask) {
  const retryTask = Number.parseInt(state._tddRetryTask, 10);
  if (!Number.isInteger(retryTask) || retryTask <= 0) return;
  const retryCount = Number.parseInt(state._tddRetryCount, 10) || 0;
  if (retryCount > 0) taskBucket(perTask, retryTask).stateRetries = retryCount;
  if (state._tddRetryPlannerDefect) taskBucket(perTask, retryTask).plannerHold = true;
}

/** Fold `.work-state.json` into per-task + ticket-level signals. */
function scanState(state, perTask) {
  const signals = { currentTask: null, knownTasks: 0 };
  if (!state || typeof state !== 'object') return signals;

  const meta = state.tasksMeta;
  const tasks = meta && Array.isArray(meta.tasks) ? meta.tasks : [];
  signals.knownTasks = tasks.length;
  if (meta && Number.isInteger(meta.currentTaskIndex)) {
    signals.currentTask = meta.currentTaskIndex + 1;
  }

  tasks.forEach((task, idx) => {
    const bucket = taskBucket(perTask, idx + 1);
    bucket.fixRounds = Number.parseInt(task && task.taskReviewFixRounds, 10) || 0;
    if (task && task.status === 'completed') bucket.completed = true;
  });

  scanRetryState(state, perTask);
  return signals;
}

/** Read + shape the two per-ticket inputs, collecting warnings. */
function readTicketInputs(dir, ticket, warnings) {
  const actionsRead = readJsonFile(path.join(dir, ACTIONS_FILE));
  const stateRead = readJsonFile(path.join(dir, STATE_FILE));

  let actions = [];
  if (actionsRead.ok) {
    if (Array.isArray(actionsRead.data)) actions = actionsRead.data;
    else warnings.push(`${ticket}: ${ACTIONS_FILE} is not a JSON array — ignored`);
  } else if (actionsRead.reason === 'malformed') {
    warnings.push(`${ticket}: malformed ${ACTIONS_FILE} — ignored`);
  }

  let state = null;
  if (stateRead.ok) {
    if (stateRead.data && typeof stateRead.data === 'object' && !Array.isArray(stateRead.data)) {
      state = stateRead.data;
    } else {
      warnings.push(`${ticket}: ${STATE_FILE} is not a JSON object — ignored`);
    }
  } else if (stateRead.reason === 'malformed') {
    warnings.push(`${ticket}: malformed ${STATE_FILE} — ignored`);
  }

  const bothMissing = actionsRead.reason === 'missing' && stateRead.reason === 'missing';
  return { actions, state, bothMissing };
}

/** Derive W1–W4 / E1–E2 verdicts on each task bucket (mutates buckets). */
function deriveTaskVerdicts(perTask, threshold) {
  const taskNums = [...perTask.keys()].sort((a, b) => a - b);
  for (const n of taskNums) {
    const b = perTask.get(n);
    b.retries = b.fixRounds + Math.max(b.gateRejections, b.stateRetries);
    b.advanced = b.completed || b.orchestratorPasses > 0 || b.reviewFailures > 0;
    b.wedged =
      b.retries > threshold || b.escalations > 0 || b.recoveries > 0 || b.plannerHold === true;
    b.escaped = b.advanced && (b.reviewFailures > 0 || b.fixRounds > 0);
  }
  return taskNums;
}

/**
 * Analyze one ticket dir. Never throws.
 * @returns {{ ticket: string, skipped: boolean, warnings: string[] }} plus
 *   the full per-ticket report fields when not skipped.
 */
function analyzeTicket(tasksBase, ticket, options) {
  const warnings = [];
  const dir = path.join(tasksBase, ticket);
  const { actions, state, bothMissing } = readTicketInputs(dir, ticket, warnings);

  if (actions.length === 0 && !state) {
    if (bothMissing) warnings.push(`${ticket}: no ${ACTIONS_FILE} or ${STATE_FILE} — skipped`);
    return { ticket, skipped: true, warnings };
  }

  const perTask = new Map();
  const actionSignals = scanActions(actions, perTask);
  const stateSignals = scanState(state, perTask);

  // W3 fallback: unattributed operator events attach to the current task.
  if (actionSignals.unattributedRecoveries > 0 && stateSignals.currentTask) {
    taskBucket(perTask, stateSignals.currentTask).recoveries +=
      actionSignals.unattributedRecoveries;
    actionSignals.unattributedRecoveries = 0;
  }

  const taskNums = deriveTaskVerdicts(perTask, options.wedgeThreshold);
  const knownTasks = Math.max(stateSignals.knownTasks, taskNums.length ? taskNums.at(-1) : 0);
  const tasks = taskNums.map((n) => perTask.get(n));
  const wedgedTasks = tasks.filter((t) => t.wedged).map((t) => t.task);
  const escapedTasks = tasks.filter((t) => t.escaped).map((t) => t.task);
  const advancedTasks = tasks.filter((t) => t.advanced).map((t) => t.task);

  return {
    ticket,
    skipped: false,
    warnings,
    knownTasks,
    advancedTasks,
    wedgedTasks,
    escapedTasks,
    wedgeRate: knownTasks > 0 ? wedgedTasks.length / knownTasks : 0,
    escapeRate: advancedTasks.length > 0 ? escapedTasks.length / advancedTasks.length : 0,
    retriesTotal: tasks.reduce((sum, t) => sum + t.retries, 0),
    perTask: tasks,
    dispatches: {
      usageRows: actionSignals.usageDispatches,
      implement: actionSignals.implementDispatches,
    },
    timeInImplementMs: actionSignals.timeInImplementMs,
    implementStepResets: actionSignals.implementStepResets,
    implementBlocks: actionSignals.implementBlocks,
    implementReentries: actionSignals.implementReentries,
    unattributedReviewFailures: actionSignals.unattributedReviewFailures,
    unattributedRecoveries: actionSignals.unattributedRecoveries,
  };
}

module.exports = {
  ACTIONS_FILE,
  STATE_FILE,
  DEFAULT_WEDGE_THRESHOLD,
  readJsonFile,
  listTicketDirs,
  analyzeTicket,
};
