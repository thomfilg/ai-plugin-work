/**
 * work-actions.js
 *
 * Shared helper for appending timestamped actions to `.work-actions.json`.
 * Actions are append-only and stored separately from `.work-state.json`
 * to keep the state file small and avoid conflicts with backward transitions.
 *
 * Record types (IDEA2 / GH-219 R13 + R16):
 *   - Legacy step-transition rows: `{ step, timestamp, what, meta? }`.
 *     Written by `appendAction()`. No `kind` field (pre-IDEA2 compatible).
 *   - Enforcement audit rows:
 *     `{ kind: 'enforcement', timestamp, origin, task, phase, action,
 *        allow, reason, outputPath, meta? }`.
 *     Written by `appendEnforcementAudit()`.
 *
 * Both record types coexist in one file. Consumers discriminate with the
 * `kind` field: enforcement rows carry `kind === ENFORCEMENT_KIND`; legacy
 * rows carry no `kind` at all. `loadActions()` returns every row verbatim;
 * `analyzeActions()` ignores enforcement rows when computing per-step
 * metrics (they are still counted in `actionCount`).
 *
 * Usage:
 *   const {
 *     appendAction,
 *     appendEnforcementAudit,
 *     loadActions,
 *     analyzeActions,
 *     ENFORCEMENT_KIND,
 *   } = require('./work-actions');
 *   appendAction('PROJ-881', { step: 'ticket', what: 'step started' });
 */

const fs = require('fs');
const path = require('path');

const getConfig = require('../../lib/get-config');

/**
 * Discriminator value for enforcement audit rows (IDEA2 spec §Pattern — audit).
 * Legacy `appendAction` rows never carry this field.
 * @type {'enforcement'}
 */
const ENFORCEMENT_KIND = 'enforcement';

/**
 * Discriminator value for usage-capture rows (GH-311).
 * Carries per-step / per-agent token, tool-use, and duration figures parsed
 * from a Task() result's `<usage>` block. Like enforcement rows, usage rows
 * are excluded from `analyzeActions()` step accounting.
 * @type {'usage'}
 */
const USAGE_KIND = 'usage';

/**
 * True for any row that is NOT a legacy step-transition row — i.e. it carries
 * a non-legacy `kind` discriminator (`enforcement` or `usage`). Such rows lack
 * the `step`/`what` shape `analyzeActions()` accounts on and are excluded from
 * per-step duration/command accounting and the totalDuration boundary, while
 * still counting in `actionCount`.
 * @param {object} row
 * @returns {boolean}
 */
function isNonLegacyRow(row) {
  return !!row && (row.kind === ENFORCEMENT_KIND || row.kind === USAGE_KIND);
}

let _tasksBase;
function getTasksBase() {
  if (!_tasksBase) _tasksBase = getConfig.require('TASKS_BASE');
  return _tasksBase;
}
// TASKS_BASE is lazy-resolved on first use via getTasksBase() — safe at require() time

function safeId(ticketId) {
  try {
    return require('../../lib/config').safeTicketId(ticketId);
  } catch {
    return ticketId;
  }
}

function actionsFilePath(ticketId) {
  return path.join(getTasksBase(), safeId(ticketId), '.work-actions.json');
}

/**
 * Load actions from `.work-actions.json` for a given ticket.
 *
 * Returns rows verbatim, including both legacy step rows (no `kind`) and
 * enforcement audit rows (`kind === ENFORCEMENT_KIND`). Missing or unreadable
 * files yield `[]` — callers should never see a throw.
 *
 * @param {string} ticketId
 * @returns {Array<object>}
 */
function loadActions(ticketId) {
  try {
    return JSON.parse(fs.readFileSync(actionsFilePath(ticketId), 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * Shared serialize-and-append helper used by `appendAction` and
 * `appendEnforcementAudit`. Ensures the ticket directory exists, loads the
 * current rows, appends `row`, and rewrites the file. Fail-open: errors are
 * swallowed so logging never breaks the workflow.
 *
 * @param {string} ticketId
 * @param {object} row — fully-built record; caller stamps its own timestamp.
 */
function appendRow(ticketId, row) {
  try {
    const filePath = actionsFilePath(ticketId);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const actions = loadActions(ticketId);
    actions.push(row);
    fs.writeFileSync(filePath, JSON.stringify(actions, null, 2));
  } catch {
    // Fail-open: never break the workflow for logging
  }
}

/**
 * Append a single legacy step-transition action to `.work-actions.json`.
 * Legacy rows are written WITHOUT a `kind` field — consumers treat any row
 * whose `kind !== ENFORCEMENT_KIND` (including absent) as a legacy row.
 *
 * @param {string} ticketId
 * @param {{step: string, what: string, meta?: object}} action
 */
function appendAction(ticketId, action) {
  appendRow(ticketId, {
    step: action.step,
    timestamp: new Date().toISOString(),
    what: action.what,
    ...(action.meta ? { meta: action.meta } : {}),
  });
}

/**
 * Append an enforcement audit record to `.work-actions.json`.
 *
 * IDEA2 / GH-219 — Task 1, requirements R13 (shape) + R16 (compatibility).
 *
 * Enforcement audit records share the same `.work-actions.json` file as
 * legacy step rows written by `appendAction()`. They are distinguished by
 * `kind: ENFORCEMENT_KIND` so `loadActions()` / `analyzeActions()` and
 * downstream consumers can filter one from the other without introducing a
 * second on-disk log (spec §Pattern — audit: "No `actions.jsonl`"). Legacy
 * rows never acquire a `kind` field — a pre-IDEA2 `.work-actions.json` with
 * only legacy rows parses via `loadActions` / `analyzeActions` unchanged.
 *
 * @param {string} ticketId
 * @param {{
 *   origin: 'workflow' | 'ai-subtask' | 'user',
 *   task: number | string | null,
 *   phase: 'red' | 'green' | 'refactor' | null,
 *   action: string,
 *   allow: boolean,
 *   reason: string,
 *   outputPath: string | null,
 *   meta?: object
 * }} entry
 */
function appendEnforcementAudit(ticketId, entry) {
  appendRow(ticketId, {
    kind: ENFORCEMENT_KIND,
    timestamp: new Date().toISOString(),
    origin: entry.origin,
    task: entry.task ?? null,
    phase: entry.phase ?? null,
    action: entry.action,
    allow: entry.allow,
    reason: entry.reason,
    outputPath: entry.outputPath ?? null,
    ...(entry.meta ? { meta: entry.meta } : {}),
  });
}

/**
 * Coerce a captured `<usage>` field to a non-negative-safe number.
 * Any non-numeric / missing value yields `0` (NaN → 0) so the report never
 * propagates `NaN`. Never throws.
 * @param {string|number|undefined} value
 * @returns {number}
 */
function coerceUsageNumber(value) {
  const n = Number(value);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Parse a `<usage>` block out of a Task() result string into a numeric record.
 *
 * GH-311 — Task 1, R1 (capture total_tokens/tool_uses/duration_ms), R7/C6
 * (graceful degradation, numeric coercion, no throw).
 *
 * Returns `{ totalTokens, toolUses, durationMs }` with each field coerced via
 * `Number(...)` (NaN → 0) when a `<usage>...</usage>` block is present, and
 * `null` when no such block exists or `text` is not a string. Missing
 * individual fields inside the block coerce to `0`; the function never throws.
 *
 * @param {string} text — raw Task() result string.
 * @returns {{totalTokens: number, toolUses: number, durationMs: number} | null}
 */
function parseUsageBlock(text) {
  if (typeof text !== 'string') return null;
  const block = text.match(/<usage>([\s\S]*?)<\/usage>/);
  if (!block) return null;

  const body = block[1];
  const field = (name) => {
    const m = body.match(new RegExp(`${name}\\s*:\\s*([^\\n\\r]*)`));
    return m ? m[1].trim() : undefined;
  };

  return {
    totalTokens: coerceUsageNumber(field('total_tokens')),
    toolUses: coerceUsageNumber(field('tool_uses')),
    durationMs: coerceUsageNumber(field('duration_ms')),
  };
}

/**
 * Append a usage-capture record to `.work-actions.json`.
 *
 * GH-311 — Task 1, R2 (kind:'usage' row keyed by step + agent for later
 * per-step / per-agent rollups), C2 (written only through the guarded
 * `appendRow()` helper — never a direct `fs.writeFileSync`).
 *
 * Usage records share the same file as legacy step rows and enforcement rows,
 * discriminated by `kind: USAGE_KIND`. `loadActions()` returns them verbatim;
 * `analyzeActions()` excludes them from per-step accounting (see
 * `isNonLegacyRow`) while still counting them in `actionCount`.
 *
 * @param {string} ticketId
 * @param {{
 *   step: string,
 *   agentType: string,
 *   totalTokens: number,
 *   toolUses: number,
 *   durationMs: number
 * }} record
 */
function appendUsage(ticketId, record) {
  appendRow(ticketId, {
    kind: USAGE_KIND,
    timestamp: new Date().toISOString(),
    step: record.step,
    agentType: record.agentType,
    totalTokens: coerceUsageNumber(record.totalTokens),
    toolUses: coerceUsageNumber(record.toolUses),
    durationMs: coerceUsageNumber(record.durationMs),
  });
}

/**
 * Compute per-step durations, bottleneck, block/retry counts from an actions array.
 * @param {Array<{step: string, timestamp: string, what: string, meta?: object}>} actions
 * @returns {{steps: Array, totalDuration: string, bottleneck: string, bottleneckDuration: string, actionCount: number}}
 */
function analyzeActions(actions) {
  if (!actions || actions.length === 0) {
    return {
      steps: [],
      totalDuration: '0s',
      bottleneck: null,
      bottleneckDuration: '0s',
      actionCount: 0,
    };
  }

  const stepMap = new Map();

  for (const action of actions) {
    // IDEA2 / GH-219 + GH-311: skip non-legacy rows (enforcement AND usage) —
    // they do not carry the `step` / `what` shape and would corrupt
    // step-duration accounting. Their record count still feeds `actionCount`
    // below. Non-legacy rows are also excluded from the totalDuration boundary
    // computation (see legacyActions filter below).
    if (isNonLegacyRow(action)) continue;

    if (!stepMap.has(action.step)) {
      stepMap.set(action.step, {
        startTime: null,
        endTime: null,
        commands: 0,
        blocks: 0,
        retries: 0,
      });
    }
    const entry = stepMap.get(action.step);
    const ts = new Date(action.timestamp).getTime();

    if (action.what === 'step started') {
      entry.startTime = ts;
    } else if (action.what === 'step completed') {
      entry.endTime = ts;
    } else if (action.what.startsWith('BLOCKED:')) {
      entry.blocks++;
    } else if (action.what === 'step reset') {
      entry.retries++;
    } else if (!['workflow started', 'step deferred', 'step skipped'].includes(action.what)) {
      entry.commands++;
    }
  }

  const steps = [];
  let maxDuration = 0;
  let bottleneck = null;

  for (const [step, data] of stepMap) {
    const duration =
      data.startTime && data.endTime ? Math.round((data.endTime - data.startTime) / 1000) : 0;

    steps.push({
      step,
      duration: `${duration}s`,
      commandCount: data.commands,
      blockCount: data.blocks,
      retryCount: data.retries,
    });

    if (duration > maxDuration) {
      maxDuration = duration;
      bottleneck = step;
    }
  }

  // Total duration: first legacy action to last legacy action.
  // Non-legacy rows (enforcement + usage) are excluded so they do not skew
  // boundary timestamps.
  const legacyActions = actions.filter((a) => !isNonLegacyRow(a));
  let totalDuration = 0;
  if (legacyActions.length > 0) {
    const firstTs = new Date(legacyActions[0].timestamp).getTime();
    const lastTs = new Date(legacyActions[legacyActions.length - 1].timestamp).getTime();
    totalDuration = Math.round((lastTs - firstTs) / 1000);
  }

  return {
    steps,
    totalDuration: `${totalDuration}s`,
    bottleneck,
    bottleneckDuration: `${maxDuration}s`,
    actionCount: actions.length,
  };
}

module.exports = {
  appendAction,
  appendEnforcementAudit,
  appendUsage,
  parseUsageBlock,
  loadActions,
  analyzeActions,
  ENFORCEMENT_KIND,
  USAGE_KIND,
  get TASKS_BASE() {
    return getTasksBase();
  },
};
