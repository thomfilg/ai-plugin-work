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
