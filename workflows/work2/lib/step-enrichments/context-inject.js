/**
 * Context injection enrichment.
 *
 * For brief/spec/implement steps, reads ticket.json and appends
 * ticket context (title + body) to the agent prompt.
 * For spec/implement steps, also injects brief.md content.
 */

'use strict';

const TICKET_CONTEXT_STEPS = ['brief', 'spec', 'implement'];
const BRIEF_CONTEXT_STEPS = ['spec', 'implement'];

module.exports = function registerContextInject(register) {
  // Inject ticket context
  for (const stepName of TICKET_CONTEXT_STEPS) {
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

  // Inject brief content
  for (const stepName of BRIEF_CONTEXT_STEPS) {
    register(stepName, (entry, ctx) => {
      const { tasksDir, path, fs } = ctx;
      const briefFile = path.join(tasksDir, 'brief.md');
      if (!fs.existsSync(briefFile)) return;
      try {
        const briefContent = fs.readFileSync(briefFile, 'utf8');
        // Truncate if too long (keep first 3000 chars to avoid prompt bloat)
        const truncated =
          briefContent.length > 3000
            ? briefContent.slice(0, 3000) +
              '\n\n[... truncated, read full file at: ' +
              briefFile +
              ']'
            : briefContent;
        const contextBlock = `\n\n## Brief Content\n\n${truncated}`;
        entry.agentPrompt = (entry.agentPrompt || '') + contextBlock;
      } catch {
        /* fail-open */
      }
    });
  }
};
