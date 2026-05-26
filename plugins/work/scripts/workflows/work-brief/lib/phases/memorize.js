/**
 * Phase: memorize — persist key decisions to an installed memory plugin.
 *
 * Three transition modes:
 *   - No memory plugin → auto-advance with summary `no-memory-plugin`.
 *   - Memory plugin + `.brief-memorized` sentinel present → advance with
 *     summary `via=<plugin name>`.
 *   - Memory plugin + no sentinel → WAIT (not blocked, just no-advance).
 *     This is signalled by `validate` returning `ok: false, errors: []`.
 *
 * The sentinel pattern lets the agent declare "I've persisted my decisions"
 * via a single file touch — we can't introspect plugin tools to verify
 * remember calls actually happened.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { BRIEF_PHASES } = require('../../brief-phase-registry');

function validate(ctx) {
  const { memory, tasksDir } = ctx;
  if (!memory) {
    return { ok: true, summary: 'no-memory-plugin' };
  }
  const sentinel = path.join(tasksDir, '.brief-memorized');
  if (fs.existsSync(sentinel)) {
    return { ok: true, summary: `via=${memory.name}` };
  }
  // Waiting (not blocked) — agent hasn't touched sentinel yet.
  return { ok: false, errors: [] };
}

function instructions(ctx) {
  const { ticket, memory, linkedIds, tasksDir } = ctx;
  if (!memory) {
    return [
      `# brief-next — Phase 5 of 5: MEMORIZE (skipped)`,
      '',
      'No memory plugin detected on this machine. Recording phase as complete with `summary=no-memory-plugin` and advancing to done.',
      '',
      'To enable memory persistence, install a plugin like cortex and re-run this workflow.',
      '',
    ].join('\n');
  }
  const sentinel = path.join(tasksDir, '.brief-memorized');
  return [
    `# brief-next — Phase 5 of 5: MEMORIZE (${memory.name})`,
    `Ticket: ${ticket}`,
    '',
    '### Task',
    `Persist your key decisions via \`${memory.rememberTool}\` so future agents can recall them. Save AT LEAST these entries (one tool call each — DO NOT batch into one entry):`,
    '',
    `1. **Ticket overview**: tag with the ticket ID and area-of-work keywords. Body = problem statement + goal from brief.md.`,
    `2. **Sibling ownership map**: for each linked ticket (${linkedIds.length}), save the verdict from sibling-overlap.md with tags ${ticket}, sibling-overlap, and the linked ticket id.`,
    `3. **P0 requirements**: save the Must Have (P0) list with tags ${ticket}, requirements, P0.`,
    `4. **Open questions + their searches**: save each unresolved Open Question with the search trail. Tag ${ticket}, open-question, plus the area keyword.`,
    `5. **Out-of-scope reasoning**: save the sibling-owned out-of-scope list so the next agent working on a related ticket can recall who owns what.`,
    '',
    memory.saveTool
      ? `Finally, archive the session via \`${memory.saveTool}\` so the full conversation context is queryable.`
      : '',
    '',
    '### How I detect completion',
    `After saving every entry above, \`touch ${sentinel}\` so I know to advance. Without that file I will stay on MEMORIZE.`,
    '',
    '### Why this matters',
    'When a sibling/follow-up ticket runs `brief-next` later, its INPUTS phase will recall these entries and avoid re-litigating decisions you already made. Skip this and you waste future agent time on questions you already answered.',
    '',
    'When done, re-invoke me and I will transition you to done.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(BRIEF_PHASES.memorize, {
    next: BRIEF_PHASES.done,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
