/**
 * Context injection enrichment.
 *
 * Injects ticket context (title + body) and file paths for artifacts.
 * For small files (ticket.json), inlines the content.
 * For larger files (brief, spec, tasks), provides paths + "READ THIS FIRST" instructions
 * so the agent reads the full content instead of getting truncated text.
 */

'use strict';

const TICKET_CONTEXT_STEPS = ['brief', 'spec', 'implement'];
const ARTIFACT_STEPS = ['spec', 'tasks', 'implement'];

module.exports = function registerContextInject(register) {
  // Inject ticket context (small — always inline)
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

  // Inject artifact file paths with read instructions (no truncation)
  for (const stepName of ARTIFACT_STEPS) {
    register(stepName, (entry, ctx) => {
      const { tasksDir, path, fs } = ctx;

      const artifacts = [];
      const briefFile = path.join(tasksDir, 'brief.md');
      const specFile = path.join(tasksDir, 'spec.md');
      const tasksFile = path.join(tasksDir, 'tasks.md');

      if (fs.existsSync(briefFile)) artifacts.push({ name: 'Brief', path: briefFile });
      if (fs.existsSync(specFile)) artifacts.push({ name: 'Spec', path: specFile });
      if (fs.existsSync(tasksFile)) artifacts.push({ name: 'Tasks', path: tasksFile });

      if (artifacts.length === 0) return;

      const lines = ['\n\n## Required Reading (MUST read before starting)'];
      artifacts.forEach((a) => {
        lines.push(`- **${a.name}:** ${a.path}`);
      });
      lines.push('');
      lines.push('Read these files IN FULL before implementing. Do NOT skip or skim.');

      entry.agentPrompt = (entry.agentPrompt || '') + lines.join('\n');
    });
  }
};
