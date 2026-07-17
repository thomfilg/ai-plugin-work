/**
 * cortex-auto-recall — Phase-1 reference /work extension.
 *
 * Fires on OnTicketResolved and injects a short "cortex recall" hint into the
 * dispatch context so the agent surfaces any historically-relevant cortex
 * memory entries to the user.
 *
 * The actual cortex memory lookup is intentionally stubbed for Phase 1; this
 * file is a worked example of the {events, handler, priority?} contract.
 *
 * See: plugins/work/docs/work-extensions.md
 */

'use strict';

/**
 * Build the cortex-recall context block for a resolved ticket.
 * Kept pure so it can be unit-tested without a ctx.
 * @param {{ticketId?: string}} payload
 * @returns {string}
 */
function buildRecall(payload) {
  const id = (payload && payload.ticketId) || 'unknown';
  return [
    `[cortex-auto-recall] Suggested cortex recall for ${id}:`,
    '  • Run `cortex recall` to surface prior decisions, blockers, and follow-ups.',
    "  • Skim any memory entries tagged with the ticket's feature area before closing.",
  ].join('\n');
}

module.exports = {
  events: ['OnTicketResolved'],
  /**
   * @param {object} payload
   * @param {{injectContext: (text: string) => void}} ctx
   */
  handler(payload, ctx) {
    ctx.injectContext(buildRecall(payload));
  },
  priority: 50,
};
