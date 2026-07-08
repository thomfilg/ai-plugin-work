/**
 * Step: 2b_transition
 * Transitions the ticket status to "In Development" (provider-specific).
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function transitionStep(add, s, ctx) {
  const { t, tp, providerConfig } = ctx;

  const transitionPrompt = tp.getTransitionPrompt(t, 'In Development', providerConfig);
  if (transitionPrompt) {
    add('2b_transition', 'RUN', 'Task(general-purpose)', 'Ticket → In Development (idempotent)', {
      agentType: 'general-purpose',
      agentPrompt: transitionPrompt,
    });
  } else {
    add('2b_transition', 'DEFER', null, 'No ticket transition for this provider');
  }
};
