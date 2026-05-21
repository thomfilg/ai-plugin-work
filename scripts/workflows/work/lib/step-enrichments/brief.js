/**
 * Brief step enrichment.
 *
 * Self-paced model: the brief-writer agent receives a minimal prompt that
 * tells it to invoke `brief-next.js`, which then drives 5 phases (inputs,
 * overlap, draft, validate, memorize). The script owns all the rules —
 * which files to read, what overlap analysis to produce, what brief
 * sections are required, what memory-plugin calls to make.
 *
 * Parallel to implement.js's task-next.js wiring.
 */

'use strict';

const path = require('path');

const BRIEF_NEXT_SCRIPT = path.resolve(__dirname, '..', '..', '..', 'work-brief', 'brief-next.js');

function buildSelfPacedPrompt(ticket) {
  return [
    `## Brief generation — ${ticket}`,
    '',
    'You are a self-paced brief-writer. Do NOT read tickets, analyze overlap,',
    'or write the brief until the script tells you the current phase.',
    '',
    '### Single instruction',
    '```bash',
    `node ${BRIEF_NEXT_SCRIPT} ${ticket}`,
    '```',
    '',
    'Run that command. Follow the Markdown response verbatim:',
    '- It will tell you the current phase (INPUTS / OVERLAP / DRAFT / VALIDATE / MEMORIZE).',
    '- It will tell you which files to read or produce.',
    '- It will tell you what must be true to advance.',
    '',
    'When you finish a phase, re-invoke the same command. The script will',
    'validate, record evidence, and either advance you or tell you precisely',
    'why it did not. Stop only when the script tells you the brief is done.',
    '',
    '### Rules',
    '- Do NOT touch brief-phase.json — it is written by the authorized recorder.',
    '- Do NOT invoke /brief, /work, or any other slash command.',
    '- Do NOT skip the overlap analysis or the memorize step.',
  ].join('\n');
}

module.exports = function registerBrief(register) {
  register('brief', (entry, ctx) => {
    if (!entry.agentPrompt) return;
    const ticket = ctx.ticket || 'TICKET';
    entry.agentPrompt = buildSelfPacedPrompt(ticket);
    entry.agentType = 'brief-writer';
  });
};
