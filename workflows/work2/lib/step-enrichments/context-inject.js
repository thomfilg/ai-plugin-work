/**
 * Context injection enrichment.
 *
 * For brief/spec/implement steps, reads ticket.json and appends
 * ticket context (title + body) to the agent prompt.
 */

'use strict';

const CONTEXT_STEPS = ['brief', 'spec', 'implement'];

module.exports = function registerContextInject(register) {
  for (const stepName of CONTEXT_STEPS) {
    register(stepName, (entry, ctx) => {
      const { tasksDir, path, fs } = ctx;
      const ticketFile = path.join(tasksDir, 'ticket.json');
      if (!fs.existsSync(ticketFile)) return;
      try {
        const ticketData = JSON.parse(fs.readFileSync(ticketFile, 'utf8'));
        const contextBlock = `\n\n## Ticket Context\nTitle: ${ticketData.title}\nState: ${ticketData.state}\n\n${ticketData.body || '(no body)'}`;
        entry.agentPrompt = (entry.agentPrompt || '') + contextBlock;
      } catch {
        /* fail-open */
      }
    });
  }
};
