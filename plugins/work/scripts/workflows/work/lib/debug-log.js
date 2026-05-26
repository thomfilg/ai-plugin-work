/**
 * Debug logger for /work orchestration.
 *
 * Appends timestamped entries to tasks/<ticket>/debug.md.
 * Always active (no env flag needed) — the file is small and
 * invaluable for post-mortem analysis.
 *
 * Usage:
 *   const { createDebugLog } = require('./debug-log');
 *   const log = createDebugLog(tasksDir);
 *   log.step('ticket', 'dispatched', { action: 'RUN' });
 *   log.transition('ticket', 'bootstrap', 'SUCCESS');
 *   log.instruction({ action: 'execute', step: 'bootstrap' });
 *   log.error('transition failed', { reason: 'not verified' });
 */

'use strict';

const fs = require('fs');
const path = require('path');

function ts() {
  return new Date()
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z/, '');
}

function createDebugLog(tasksDir) {
  const logPath = tasksDir ? path.join(tasksDir, 'debug.md') : null;

  function append(line) {
    if (!logPath) return;
    try {
      // Create dir if needed (first call)
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, line + '\n');
    } catch {
      /* fail-open */
    }
  }

  function header() {
    if (!logPath) return;
    if (!fs.existsSync(logPath)) {
      append('# /work Debug Log\n');
    }
  }

  return {
    /** Log a new work-next.js invocation */
    call(ticket, args) {
      header();
      append(`\n## ${ts()} — work-next.js ${ticket} ${args || ''}\n`);
    },

    /** Log current state snapshot */
    state(currentStep, stepStatus, dispatched) {
      const active = Object.entries(stepStatus || {})
        .filter(([, v]) => v !== 'pending')
        .map(([k, v]) => `${k}:${v}`)
        .join(', ');
      append(`- **State:** step=${currentStep}, dispatched=${dispatched || 'none'}`);
      append(`- **Status:** ${active || '(all pending)'}`);
    },

    /** Log a step being processed */
    step(stepName, action, extra) {
      const details = extra ? ` — ${JSON.stringify(extra)}` : '';
      append(`- **Step ${stepName}:** ${action}${details}`);
    },

    /** Log a transition attempt */
    transition(from, to, result) {
      const icon = result === 'SUCCESS' ? '✓' : '✗';
      append(`- **Transition** ${from} → ${to}: ${icon} ${result}`);
    },

    /** Log the instruction being returned */
    instruction(instr) {
      if (!instr) return;
      const step = instr.state?.currentStep || instr.step || '?';
      const delegateType = instr.delegate?.type || '?';
      const delegateName =
        instr.delegate?.name || instr.delegate?.agentType || instr.delegate?.command || '?';
      append(
        `- **Instruction:** action=${instr.action}, step=${step}, delegate=${delegateType}:${delegateName}`
      );
    },

    /** Log an error or block */
    error(msg, extra) {
      const details = extra ? ` ${JSON.stringify(extra)}` : '';
      append(`- **ERROR:** ${msg}${details}`);
    },

    /** Log enrichment applied */
    enrichment(stepName, description) {
      append(`- **Enrichment** ${stepName}: ${description}`);
    },

    /** Log recursion */
    recurse(depth, reason) {
      append(`- **Recurse** depth=${depth}: ${reason}`);
    },

    /** Raw line */
    raw(line) {
      append(line);
    },
  };
}

module.exports = { createDebugLog };
