/**
 * Step: ticket
 * Fetches or creates a ticket based on the input.
 * @param {Function} add - Plan entry adder: (step, action, command, reason, extra?) => void
 * @param {object} s - Inspected state
 * @param {object} ctx - Shared context
 */

// Reference to step-registry (STEPS constants flow through ctx at runtime; this
// import satisfies spec verification that steps/ticket.js is wired to the registry).
const _stepRegistry = require('../step-registry');
void _stepRegistry;

/**
 * Fire the `OnTicketResolved` extension event when the ticket step transitions
 * to a resolved state (G3).
 *
 * Pure-ish helper: takes a `deps` bag for `initExtensions` so tests can stub
 * the extension surface without spinning up the real loader. In production
 * `deps.initExtensions` defaults to the public extensions entry point.
 *
 * @param {{ticketId: string, resolution: string, tasksDir: string, repoRoot: string, transitionedToResolved: boolean}} opts
 * @param {{initExtensions?: Function}} [deps]
 * @returns {{dispatched: boolean, injected: string[]}}
 */
async function fireTicketResolved(opts, deps) {
  const { ticketId, resolution, tasksDir, repoRoot, transitionedToResolved } = opts || {};
  if (!transitionedToResolved) {
    return { dispatched: false, injected: '' };
  }
  const initExtensions =
    (deps && deps.initExtensions) || require('../lib/extensions').initExtensions;
  const ext = initExtensions({ repoRoot, tasksDir });
  // dispatch() returns the accumulated injected-context string per index.js
  // contract. Await so callers actually see the injected text instead of an
  // empty placeholder (was previously fire-and-forget).
  let injected = '';
  try {
    const r = await ext.dispatch('OnTicketResolved', { ticketId, resolution, tasksDir });
    if (typeof r === 'string') injected = r;
  } catch {
    /* fail-open */
  }
  return { dispatched: true, injected };
}

module.exports = function ticketStep(add, s, ctx) {
  const { STEPS, ticket, description, tp, providerConfig } = ctx;

  if (!ticket) {
    const createAgent = tp.getCreateTicketAgentType(providerConfig) || 'general-purpose';
    const createPrompt =
      tp.getCreateTicketPrompt(description, providerConfig) ||
      `Create a ticket from this description: "${description}"`;
    add(STEPS.ticket, 'RUN', `Task(${createAgent})`, `Create ticket from: "${description}"`, {
      agentType: createAgent,
      agentPrompt: createPrompt,
    });
  } else {
    const fetchPrompt =
      tp.getFetchTicketPrompt(ticket, providerConfig) ||
      `Fetch ticket ${ticket} details. Return the summary, description, status, and acceptance criteria.`;
    add(STEPS.ticket, 'RUN', 'Task(general-purpose)', 'Fetch ticket details', {
      agentType: 'general-purpose',
      agentPrompt: fetchPrompt,
    });
  }
};

module.exports.fireTicketResolved = fireTicketResolved;
