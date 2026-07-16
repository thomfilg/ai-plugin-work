'use strict';

/**
 * work-state/recover.js — the sanctioned wedge-recovery primitive (GH-753,
 * outcome-verification Phase 1.2).
 *
 * Wedged tickets were historically recovered by 20–40 minutes of operator
 * surgery on hook-protected state files (GH-721 green→red rewind catch-22,
 * GH-736 tasksMeta desync with 34+ retries, GH-724 unreopenable completed
 * task, GH-722/GH-509/GH-462). This module gives the operator a first-class,
 * audited exit:
 *
 *   node work-state.js recover <ticket> --action <action> [--task N]
 *        --approved-by <who> --reason "<why>"
 *
 * Actions (CONSISTENCY-ONLY — recovery returns state to a re-attemptable
 * configuration; it NEVER mints evidence or completion):
 *   abandon-cycle  Clear the in-flight TDD retry/dispatch state for task N and
 *                  archive its tdd-phase.json (renamed, not deleted). The task
 *                  is re-attempted through the normal gate.
 *   resync-meta    Rebuild tasksMeta from tasks.md, preserving completed
 *                  statuses by task id (fixes the GH-736 desync class).
 *   reopen-task    Mark completed task N back to pending and repoint the
 *                  task pointer (GH-724/GH-721 class); the orchestrator
 *                  re-runs it through the normal gate.
 *
 * Approval: `--approved-by` + `--reason` are mandatory. The orchestrating
 * session must obtain operator approval (AskUserQuestion) BEFORE invoking;
 * the CLI records both in the audit row. Every recovery appends an
 * enforcement row (`action: recover-<action>`, `allow: true`) with
 * before/after snapshots. A tripwire warns loudly when a ticket accumulates
 * more than WORK_RECOVER_TRIPWIRE (default 3) recoveries — that volume means
 * a harness/planner defect that must be filed, not recovered around.
 *
 * After the outcome-mode flip (GH-756) this primitive remains the `escalate`
 * typed exit.
 */

const fs = require('fs');
const path = require('path');

const { loadState, saveState, getStatePath, taskSegment } = require('./core');
const { RETRY_KEYS } = require(
  path.join(__dirname, '..', 'lib', 'step-enrichments', 'implement-gate', 'planner-hold')
);
const { parseTasks } = require(path.join(__dirname, '..', 'lib', 'task-graph'));

const DISPATCH_KEYS = ['_preTestForTask', '_work2Dispatched', '_work2DispatchedAction'];
const RECOVER_ACTIONS = ['abandon-cycle', 'resync-meta', 'reopen-task'];
const TASK_REQUIRED = new Set(['abandon-cycle', 'reopen-task']);

function tripwireThreshold() {
  const parsed = Number.parseInt(process.env.WORK_RECOVER_TRIPWIRE, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 3;
}

/** Parse `recover` CLI flags. Returns { options } or { error }. */
function parseRecoverArgs(argv) {
  const options = { task: null, action: null, approvedBy: null, reason: null };
  const FLAGS = {
    '--task': (v) => {
      options.task = Number.parseInt(v, 10);
    },
    '--action': (v) => {
      options.action = v;
    },
    '--approved-by': (v) => {
      options.approvedBy = v;
    },
    '--reason': (v) => {
      options.reason = v;
    },
  };
  for (let i = 0; i < argv.length; i++) {
    const apply = FLAGS[argv[i]];
    if (!apply) return { error: `recover: unknown argument: ${argv[i]}` };
    const value = argv[++i];
    if (value === undefined) return { error: `recover: ${argv[i - 1]} needs a value` };
    apply(value);
  }
  return { options };
}

/** Validate parsed options against the action contracts. Returns error or null. */
function validateRecoverOptions(options) {
  if (!RECOVER_ACTIONS.includes(options.action)) {
    return `recover: --action must be one of: ${RECOVER_ACTIONS.join(' | ')}`;
  }
  if (!options.approvedBy || !options.reason) {
    return 'recover: --approved-by and --reason are mandatory (operator approval is recorded, never assumed)';
  }
  if (TASK_REQUIRED.has(options.action) && (!Number.isInteger(options.task) || options.task < 1)) {
    return `recover: --task <n> (1-based) is required for ${options.action}`;
  }
  return null;
}

/** Compact state summary for the audit trail. */
function snapshot(state) {
  const meta = state.tasksMeta || {};
  const tasks = Array.isArray(meta.tasks) ? meta.tasks : [];
  return {
    currentTaskIndex: meta.currentTaskIndex ?? null,
    statuses: tasks.map((t) => t.status),
    transientKeys: [...RETRY_KEYS, ...DISPATCH_KEYS].filter((k) => state[k] !== undefined),
  };
}

/** abandon-cycle: clear in-flight retry/dispatch state + archive task evidence. */
function doAbandonCycle(ticketId, state, taskNum) {
  const tasks = state.tasksMeta?.tasks;
  if (!Array.isArray(tasks)) return { error: 'recover: no task tracking initialized' };
  if (taskNum > tasks.length) {
    return { error: `recover: task ${taskNum} out of range (1..${tasks.length})` };
  }
  if (tasks[taskNum - 1].status === 'completed') {
    return { error: `recover: task ${taskNum} is completed — use --action reopen-task instead` };
  }

  const cleared = [...RETRY_KEYS, ...DISPATCH_KEYS].filter((k) => state[k] !== undefined);
  for (const key of cleared) delete state[key];

  const evidencePath = path.join(
    path.dirname(getStatePath(ticketId)),
    taskSegment(taskNum),
    'tdd-phase.json'
  );
  let archivedTo = null;
  if (fs.existsSync(evidencePath)) {
    archivedTo = `${evidencePath}.recovered-${Date.now()}`;
    fs.renameSync(evidencePath, archivedTo);
  }

  if (cleared.length === 0 && !archivedTo) {
    return { noop: true, message: 'nothing to abandon — no in-flight cycle state found' };
  }
  // Archive-only recoveries mutate no state fields — skip the write so the
  // state file's timestamp only moves when its content does.
  if (cleared.length > 0) saveState(ticketId, state);
  return { cleared, archivedEvidence: archivedTo };
}

/** Rebuild one tasksMeta entry from a parsed tasks.md task + its old entry. */
function rebuildEntry(parsedTask, oldEntry) {
  const entry = { id: `task_${parsedTask.num}`, status: 'pending' };
  if (parsedTask.title) entry.title = parsedTask.title;
  entry.dependencies = (parsedTask.dependencies || []).slice();
  if (oldEntry) {
    if (oldEntry.kind !== undefined) entry.kind = oldEntry.kind;
    if (oldEntry.status === 'completed') {
      entry.status = 'completed';
      entry.taskReviewFixRounds = oldEntry.taskReviewFixRounds || 0;
    }
  }
  return entry;
}

/** One tasksMeta entry equals its rebuilt counterpart on controlled fields. */
function entryMatches(oldEntry, rebuiltEntry) {
  return (
    oldEntry?.id === rebuiltEntry.id &&
    oldEntry?.status === rebuiltEntry.status &&
    JSON.stringify(oldEntry?.dependencies || []) === JSON.stringify(rebuiltEntry.dependencies || [])
  );
}

/** tasksMeta equals the rebuilt meta on every field resync-meta controls. */
function metaMatchesRebuilt(oldMeta, rebuilt) {
  return (
    oldMeta.totalTasks === rebuilt.totalTasks &&
    oldMeta.currentTaskIndex === rebuilt.currentTaskIndex &&
    Array.isArray(oldMeta.tasks) &&
    oldMeta.tasks.length === rebuilt.tasks.length &&
    rebuilt.tasks.every((t, i) => entryMatches(oldMeta.tasks[i], t))
  );
}

/** resync-meta: rebuild tasksMeta from tasks.md, preserving completed-by-id. */
function doResyncMeta(ticketId, state) {
  let parsed;
  try {
    parsed = parseTasks(path.dirname(getStatePath(ticketId)));
  } catch (err) {
    return { error: `recover: cannot parse tasks.md (${err.message})` };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { error: 'recover: tasks.md has no parseable tasks — nothing to resync against' };
  }

  const oldMeta = state.tasksMeta || { tasks: [] };
  const oldById = new Map((oldMeta.tasks || []).map((t) => [t.id, t]));
  const tasks = parsed.map((p) => rebuildEntry(p, oldById.get(`task_${p.num}`)));

  const firstOpen = tasks.findIndex((t) => t.status !== 'completed');
  const rebuilt = {
    totalTasks: tasks.length,
    currentTaskIndex: firstOpen === -1 ? tasks.length : firstOpen,
    tasks,
  };

  // Field-wise noop check over the fields resync-meta actually controls
  // (count, pointer, ids, statuses, dependencies) — a stringify comparison
  // would treat unknown extra fields or key order as a difference and
  // silently drop those fields on every invocation.
  if (metaMatchesRebuilt(oldMeta, rebuilt)) {
    return { noop: true, message: 'tasksMeta already matches tasks.md — nothing to resync' };
  }
  state.tasksMeta = rebuilt;
  saveState(ticketId, state);
  return {
    totalTasks: rebuilt.totalTasks,
    currentTaskIndex: rebuilt.currentTaskIndex,
    preservedCompleted: tasks.filter((t) => t.status === 'completed').map((t) => t.id),
  };
}

/** reopen-task: completed → pending, repoint the task pointer. */
function doReopenTask(ticketId, state, taskNum) {
  const meta = state.tasksMeta;
  if (!meta || !Array.isArray(meta.tasks)) {
    return { error: 'recover: no task tracking initialized' };
  }
  if (taskNum > meta.tasks.length) {
    return { error: `recover: task ${taskNum} out of range (1..${meta.tasks.length})` };
  }
  const task = meta.tasks[taskNum - 1];
  if (task.status !== 'completed') {
    return {
      error: `recover: task ${taskNum} is "${task.status}" — reopen-task only reopens completed tasks`,
    };
  }

  task.status = 'pending';
  task.taskReviewFixRounds = 0;
  meta.currentTaskIndex = Math.min(meta.currentTaskIndex ?? taskNum - 1, taskNum - 1);
  saveState(ticketId, state);
  return { reopened: `task_${taskNum}`, currentTaskIndex: meta.currentTaskIndex };
}

/** Count prior recover-* audit rows for the tripwire. Never throws. */
function countRecoveries(ticketId) {
  try {
    const auditPath = path.join(path.dirname(getStatePath(ticketId)), '.work-actions.json');
    const rows = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
    // No-op probes stay in the audit trail but do NOT count against the
    // tripwire: four diagnostic probes on a healthy task are zero actual
    // recoveries, and alarming on them would mask the real signal.
    return rows.filter(
      (r) =>
        r.kind === 'enforcement' &&
        /^recover-/.test(String(r.action || '')) &&
        !(r.meta && r.meta.outcome && r.meta.outcome.noop === true)
    ).length;
  } catch {
    return 0;
  }
}

/** Audit the recovery. Best-effort — the recovery itself must not fail. */
function auditRecovery(ticketId, options, before, after, outcome) {
  try {
    const { appendEnforcementAudit } = require(path.join(__dirname, '..', 'lib', 'work-actions'));
    appendEnforcementAudit(ticketId, {
      origin: 'user',
      task: options.task,
      phase: null,
      action: `recover-${options.action}`,
      allow: true,
      reason: options.reason,
      outputPath: null,
      meta: { approvedBy: options.approvedBy, before, after, outcome },
    });
  } catch {
    /* audit failure must not undo a successful recovery */
  }
}

const ACTION_RUNNERS = {
  'abandon-cycle': (ticketId, state, options) => doAbandonCycle(ticketId, state, options.task),
  'resync-meta': (ticketId, state) => doResyncMeta(ticketId, state),
  'reopen-task': (ticketId, state, options) => doReopenTask(ticketId, state, options.task),
};

/**
 * Run one recovery. @returns result object; `{ error }` on refusal.
 */
function recoverState(ticketId, options) {
  const invalid = validateRecoverOptions(options);
  if (invalid) return { error: invalid };

  const state = loadState(ticketId);
  if (!state) return { error: `recover: no work state found for ${ticketId}` };

  const before = snapshot(state);
  const outcome = ACTION_RUNNERS[options.action](ticketId, state, options);
  if (outcome.error) return outcome;

  const after = snapshot(loadState(ticketId) || state);
  auditRecovery(ticketId, options, before, after, outcome);

  const result = { success: true, action: options.action, task: options.task, ...outcome };
  const recoveries = countRecoveries(ticketId);
  const threshold = tripwireThreshold();
  if (recoveries > threshold) {
    result.tripwire = {
      recoveries,
      threshold,
      message:
        `TRIPWIRE: ${recoveries} recoveries on ${ticketId} (threshold ${threshold}). ` +
        'This volume means a harness/planner defect — file an issue with the ' +
        '.work-actions.json recover-* rows instead of recovering again.',
    };
    process.stderr.write(`${result.tripwire.message}\n`);
  }
  return result;
}

module.exports = {
  RECOVER_ACTIONS,
  parseRecoverArgs,
  validateRecoverOptions,
  recoverState,
};
