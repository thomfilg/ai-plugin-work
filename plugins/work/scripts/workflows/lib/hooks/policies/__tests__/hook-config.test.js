/**
 * Tests for policies/hook-config.js — Task 4 (GH-339)
 *
 * Rule 3b must route the work-state `cancel` sub-command through the
 * terminal-bypass gate rather than treat it as blanket-safe. That means:
 *
 *   - `cancel` is NOT a member of SAFE_SUBCOMMANDS['work-state.js'] (a blanket-safe
 *     read-only entry would let a dispatched subagent invoke it unguarded).
 *   - hook-config recognizes `cancel` as gated-via-terminal-bypass by listing it
 *     alongside `complete` in a TERMINAL_BYPASS_SUBCOMMANDS alignment set, so the
 *     allowlist/exempt-pattern config stays consistent with the Rule-3b bypass
 *     path in state-script-gate.js (isTerminalBypassEligible).
 *   - The pre-existing work-state safe set (get, resume-info, init, …) is unchanged.
 *
 * Run: node --test workflows/lib/hooks/policies/__tests__/hook-config.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { SAFE_SUBCOMMANDS, TERMINAL_BYPASS_SUBCOMMANDS } = require('../hook-config');
const { isTerminalBypassEligible } = require('../state-script-gate');

// The read-only/idempotent set that existed before GH-339's cancel work. `cancel`
// must NOT be added to this set, and none of these entries may be dropped.
const EXPECTED_WORK_STATE_SAFE = [
  'get',
  'resume-info',
  'init',
  'active-subtask',
  'add-error',
  'task-init',
  'task-current',
  'task-get',
];

describe('hook-config: work-state.js cancel routing (GH-339 Task 4)', () => {
  it('does NOT list cancel in the blanket-safe SAFE_SUBCOMMANDS set', () => {
    const safe = SAFE_SUBCOMMANDS['work-state.js'];
    assert.ok(safe instanceof Set, 'SAFE_SUBCOMMANDS[work-state.js] is a Set');
    assert.equal(
      safe.has('cancel'),
      false,
      'cancel must be gated via terminal-bypass, never blanket-safe (AC10)'
    );
  });

  it('recognizes cancel as gated-via-terminal-bypass, mirroring complete', () => {
    assert.ok(
      TERMINAL_BYPASS_SUBCOMMANDS && typeof TERMINAL_BYPASS_SUBCOMMANDS === 'object',
      'hook-config exports a TERMINAL_BYPASS_SUBCOMMANDS alignment map'
    );
    const bypass = TERMINAL_BYPASS_SUBCOMMANDS['work-state.js'];
    assert.ok(bypass instanceof Set, 'TERMINAL_BYPASS_SUBCOMMANDS[work-state.js] is a Set');
    assert.equal(bypass.has('cancel'), true, 'cancel is routed through the terminal bypass');
    assert.equal(
      bypass.has('complete'),
      true,
      'cancel alignment sits alongside complete (both gated-via-bypass)'
    );
  });

  it('keeps the bypass alignment consistent with state-script-gate.isTerminalBypassEligible', () => {
    // hook-config's alignment set must not drift from the actual Rule-3b bypass
    // predicate: every entry it claims is gated-via-bypass must be eligible there,
    // and the blanket-safe set must stay disjoint from it.
    const bypass = TERMINAL_BYPASS_SUBCOMMANDS['work-state.js'];
    for (const subCmd of bypass) {
      assert.equal(
        isTerminalBypassEligible('work-state.js', subCmd),
        true,
        `${subCmd} is bypass-eligible in state-script-gate`
      );
    }
    const safe = SAFE_SUBCOMMANDS['work-state.js'];
    for (const subCmd of bypass) {
      assert.equal(safe.has(subCmd), false, `${subCmd} is not also blanket-safe`);
    }
  });

  it('leaves the pre-existing work-state.js safe set unchanged', () => {
    const safe = SAFE_SUBCOMMANDS['work-state.js'];
    for (const entry of EXPECTED_WORK_STATE_SAFE) {
      assert.equal(safe.has(entry), true, `${entry} remains blanket-safe`);
    }
    assert.equal(
      safe.size,
      EXPECTED_WORK_STATE_SAFE.length,
      'no extra sub-commands added to the work-state.js safe set'
    );
  });
});
