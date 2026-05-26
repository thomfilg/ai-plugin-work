/**
 * Ticket step enrichment.
 *
 * Adds instruction to save ticket JSON output to a file for downstream
 * context injection.
 */

'use strict';

module.exports = function registerTicket(register) {
  register('ticket', (entry, ctx) => {
    const { tasksDir, ticket, path, fs } = ctx;
    const ticketFile = path.join(tasksDir, 'ticket.json');
    const issueNum = ticket.replace('#', '');
    const saveCmd = `gh issue view ${issueNum} --json title,body,state,labels > "${ticketFile}"`;
    entry.agentPrompt = `${entry.agentPrompt}\n\nIMPORTANT: Also save the raw JSON output to: ${ticketFile}\nRun: ${saveCmd}`;
  });
};
