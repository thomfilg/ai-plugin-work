/**
 * Tests for policies/state-script-gate.js — Task 3 (GH-339)
 *
 *   - isTerminalSessionGuardBypass additively allows guard release when the
 *     work-state status is `cancelled` (GH-339 AC9), while still rejecting a
 *     dispatched-agent context first (GH-695) and leaving the terminal-`complete`
 *     allowance intact.
 *   - The work-state `cancel` sub-command is routed through the Rule-3b
 *     terminal-bypass path (GH-339 AC10): a dispatched subagent is blocked with
 *     the dispatched-agent guidance, while a non-dispatched, strict,
 *     planning-phase invocation is allowed through.
 *
 * Run: node --test workflows/lib/hooks/policies/__tests__/state-script-gate.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  createStateScriptGate,
  DISPATCHED_AGENT_GUIDANCE,
  isTerminalBypassEligible,
} = require('../state-script-gate');

// Real script paths under a trusted dir so isTrustedScriptPath() passes.
// __tests__ → policies → hooks → lib → workflows, then work/work-state.js.
const WORK_STATE_JS = path.resolve(__dirname, '..', '..', '..', '..', 'work', 'work-state.js');
// __tests__ → policies → hooks, then session-guard.js.
const SESSION_GUARD_JS = path.resolve(__dirname, '..', '..', 'session-guard.js');
// workflows is a shared ancestor of both scripts above.
const TRUSTED_DIR = path.resolve(__dirname, '..', '..', '..', '..');

const TICKET = 'GH-339';

/**
 * Build a deps object for createStateScriptGate.
 * @param {object} o
 * @param {string} o.status — work-state status returned by loadStateFile
 * @param {string} o.step — current step returned by getCurrentStep
 * @param {boolean} o.dispatched — whether isDispatchedAgentContext returns true
 */
function makeDeps({ status = 'in_progress', step = 'spec', dispatched = false } = {}) {
  return {
    trustedDirs: [TRUSTED_DIR],
    safeSubcommands: {
      'work-state.js': new Set(['get', 'resume-info']),
      'session-guard.js': new Set(['status']),
    },
    loadStateFile: () => ({ status }),
    getCurrentStep: () => step,
    workSteps: ['ticket', 'brief', 'spec', 'spec_gate', 'tasks', 'implement', 'complete'],
    tasksBase: '/tmp/tasks',
    safeTicketPath: (t) => `/tmp/tasks/${t}`,
    debugLogCandidatePath: () => {},
    isDispatchedAgentContext: () => dispatched === true,
  };
}

describe('state-script-gate: isTerminalSessionGuardBypass — cancelled guard release (GH-339 AC9)', () => {
  it('the terminal-bypass predicate allows guard release when status is cancelled', () => {
    // Status cancelled at a NON-complete step (spec): today only `complete`
    // is allowed, so this must fail until the additive OR clause lands.
    const gate = createStateScriptGate(makeDeps({ status: 'cancelled', step: 'spec' }));
    const cmd = `node ${SESSION_GUARD_JS} finish ${TICKET}`;
    assert.equal(
      gate.isTerminalSessionGuardBypass(cmd, TICKET, {}),
      true,
      'guard release should be allowed when work-state status is cancelled'
    );
  });

  it('still rejects a dispatched-agent context first even when status is cancelled', () => {
    const gate = createStateScriptGate(
      makeDeps({ status: 'cancelled', step: 'spec', dispatched: true })
    );
    const cmd = `node ${SESSION_GUARD_JS} finish ${TICKET}`;
    assert.equal(
      gate.isTerminalSessionGuardBypass(cmd, TICKET, { transcript_path: '/tmp/t.jsonl' }),
      false,
      'dispatched-agent context must be rejected before the cancelled allowance'
    );
  });

  it('keeps the terminal-complete allowance unchanged (status in_progress at complete)', () => {
    const gate = createStateScriptGate(makeDeps({ status: 'in_progress', step: 'complete' }));
    const cmd = `node ${SESSION_GUARD_JS} finish ${TICKET}`;
    assert.equal(
      gate.isTerminalSessionGuardBypass(cmd, TICKET, {}),
      true,
      'the existing complete-step allowance must remain intact'
    );
  });

  it('rejects guard release for a non-cancelled state at a non-complete step', () => {
    const gate = createStateScriptGate(makeDeps({ status: 'in_progress', step: 'spec' }));
    const cmd = `node ${SESSION_GUARD_JS} finish ${TICKET}`;
    assert.equal(
      gate.isTerminalSessionGuardBypass(cmd, TICKET, {}),
      false,
      'a mid-workflow in_progress state must not release the guard'
    );
  });
});

describe('state-script-gate: work-state.js cancel gating (GH-339 AC10)', () => {
  it('a dispatched subagent cannot invoke work-state.js cancel', () => {
    // Cancel is routed through Rule 3b: a dispatched context must be blocked and
    // the block message must carry the dispatched-agent guidance.
    const gate = createStateScriptGate(
      makeDeps({ status: 'in_progress', step: 'spec', dispatched: true })
    );
    const cmd = `node ${WORK_STATE_JS} cancel ${TICKET} --reason "abc"`;
    const result = gate.checkUnsafeSubcommands(cmd, TICKET, {
      transcript_path: '/tmp/t.jsonl',
    });
    assert.ok(result, 'cancel from a dispatched context must be blocked');
    assert.equal(result.blocked, true);
    assert.ok(
      result.message.includes(DISPATCHED_AGENT_GUIDANCE),
      'block message must include the dispatched-agent guidance'
    );
  });

  it('allows a non-dispatched strict planning-phase work-state.js cancel', () => {
    const gate = createStateScriptGate(
      makeDeps({ status: 'in_progress', step: 'spec', dispatched: false })
    );
    const cmd = `node ${WORK_STATE_JS} cancel ${TICKET} --reason "abc"`;
    const result = gate.checkUnsafeSubcommands(cmd, TICKET, {});
    assert.equal(
      result,
      null,
      'a non-dispatched planning-phase cancel must be allowed through (not blocked)'
    );
  });

  it('cancel is a terminal-bypass-eligible sub-command on work-state.js', () => {
    assert.equal(
      isTerminalBypassEligible('work-state.js', 'cancel'),
      true,
      'cancel must be terminal-bypass eligible so the dispatched guidance applies'
    );
  });
});
