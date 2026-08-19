/**
 * flaky-test-runbook — Phase-1 reference /work extension.
 *
 * Fires on OnAgentResponseMatched whenever the agent text mentions
 * "flake" / "flaky" (case-insensitive) and injects a short runbook pointer
 * so the agent investigates the root cause instead of re-running CI.
 *
 * See: plugins/work/docs/work-extensions.md
 */

'use strict';

const RUNBOOK = [
  '[flaky-test-runbook] Flaky-test signal detected.',
  'Runbook:',
  '  1. Do NOT `gh run rerun` — investigate logs first.',
  '  2. Reproduce locally with the exact failing seed / order.',
  '  3. Isolate the non-determinism (timing, fixture leak, network, env).',
  '  4. Land a regression test that fails reliably before fixing.',
].join('\n');

module.exports = {
  events: ['OnAgentResponseMatched'],
  match: /flak(e|y)/i,
  /**
   * @param {object} _payload
   * @param {{injectContext: (text: string) => void}} ctx
   */
  handler(_payload, ctx) {
    ctx.injectContext(RUNBOOK);
  },
  priority: 50,
};
