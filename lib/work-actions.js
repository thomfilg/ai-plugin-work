/**
 * work-actions.js
 *
 * Shared helper for appending timestamped actions to .work-actions.json.
 * Actions are append-only and stored separately from .work-state.json
 * to keep the state file small and avoid conflicts with backward transitions.
 *
 * Usage:
 *   const { appendAction, loadActions, analyzeActions } = require('./work-actions');
 *   appendAction('PROJ-881', { step: '1_ticket', what: 'step started' });
 */

const fs = require('fs');
const path = require('path');

const TASKS_BASE = path.join(process.env.HOME || '/home/node', 'worktrees', 'tasks');

/**
 * Load actions from .work-actions.json for a given ticket.
 * @param {string} ticketId
 * @returns {Array<{step: string, timestamp: string, what: string, meta?: object}>}
 */
function loadActions(ticketId) {
  const filePath = path.join(TASKS_BASE, ticketId, '.work-actions.json');
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * Append a single action to .work-actions.json.
 * @param {string} ticketId
 * @param {{step: string, what: string, meta?: object}} action
 */
function appendAction(ticketId, action) {
  const dir = path.join(TASKS_BASE, ticketId);
  const filePath = path.join(dir, '.work-actions.json');

  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const actions = loadActions(ticketId);
    actions.push({
      step: action.step,
      timestamp: new Date().toISOString(),
      what: action.what,
      ...(action.meta ? { meta: action.meta } : {}),
    });

    fs.writeFileSync(filePath, JSON.stringify(actions, null, 2));
  } catch {
    // Fail-open: never break the workflow for logging
  }
}

/**
 * Compute per-step durations, bottleneck, block/retry counts from an actions array.
 * @param {Array<{step: string, timestamp: string, what: string, meta?: object}>} actions
 * @returns {{steps: Array, totalDuration: string, bottleneck: string, bottleneckDuration: string, actionCount: number}}
 */
function analyzeActions(actions) {
  if (!actions || actions.length === 0) {
    return { steps: [], totalDuration: '0s', bottleneck: null, bottleneckDuration: '0s', actionCount: 0 };
  }

  const stepMap = new Map();

  for (const action of actions) {
    if (!stepMap.has(action.step)) {
      stepMap.set(action.step, { startTime: null, endTime: null, commands: 0, blocks: 0, retries: 0 });
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
    } else if (!['workflow started', 'step skipped'].includes(action.what)) {
      entry.commands++;
    }
  }

  const steps = [];
  let maxDuration = 0;
  let bottleneck = null;

  for (const [step, data] of stepMap) {
    const duration = (data.startTime && data.endTime)
      ? Math.round((data.endTime - data.startTime) / 1000)
      : 0;

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

  // Total duration: first action to last action
  const firstTs = new Date(actions[0].timestamp).getTime();
  const lastTs = new Date(actions[actions.length - 1].timestamp).getTime();
  const totalDuration = Math.round((lastTs - firstTs) / 1000);

  return {
    steps,
    totalDuration: `${totalDuration}s`,
    bottleneck,
    bottleneckDuration: `${maxDuration}s`,
    actionCount: actions.length,
  };
}

module.exports = { appendAction, loadActions, analyzeActions, TASKS_BASE };
