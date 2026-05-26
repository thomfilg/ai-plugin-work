/**
 * Phase: inputs — fetch ticket + every linked ticket's full content into _related/.
 *
 * The agent must (1) recall prior memory if a plugin is installed and
 * (2) save each linked ticket's full description to `_related/<id>.md`.
 * We validate the manifest exists and that every `_related/<id>.md` is
 * present with at least 50 chars of body.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { BRIEF_PHASES } = require('../../brief-phase-registry');

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function validateArtifacts(tasksDir, manifest, linkedIds) {
  const errors = [];
  if (!manifest) {
    errors.push(
      `related-tickets.json missing at ${path.join(tasksDir, 'related-tickets.json')}. Cannot proceed without sibling context.`
    );
    return errors;
  }
  // No linked tickets => nothing to put in _related/ => nothing to check.
  if (linkedIds.length === 0) return errors;

  const relDir = path.join(tasksDir, '_related');
  if (!fs.existsSync(relDir)) {
    errors.push(
      `Missing directory ${relDir}. Save each linked ticket's full content as ${relDir}/<TICKET-ID>.md.`
    );
    return errors;
  }
  for (const id of linkedIds) {
    const f = path.join(relDir, `${id}.md`);
    const c = readFile(f);
    if (!c || c.trim().length < 50) {
      errors.push(
        `Missing or too-short ${f} (< 50 chars). Fetch the linked ticket's FULL description (not just title) and save it here.`
      );
    }
  }
  return errors;
}

function validate(ctx) {
  const errors = validateArtifacts(ctx.tasksDir, ctx.manifest, ctx.linkedIds);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    summary: `linked=${ctx.linkedIds.length} memory=${ctx.memory ? ctx.memory.name : 'none'}`,
  };
}

function instructions(ctx) {
  const { ticket, tasksDir, linkedIds, manifest, memory } = ctx;
  const memBlock = memory
    ? [
        '',
        `### 0. Recall prior memory (${memory.name})`,
        `Before reading anything, call \`${memory.recallTool}\` with each of these queries (one call per query) and read the results:`,
        `- \`${ticket}\``,
        `- the ticket title (extract from related-tickets.json self field if present)`,
        `- "${ticket} brief"`,
        `- "sibling overlap" + the area of work (e.g. tRPC, schema, component name)`,
        `- "past decisions" + the area of work`,
        '',
        'Treat any hits as authoritative prior context — read them in full before you draft anything. If multiple agents have already decided how to scope this ticket, do not re-litigate; carry the decision forward.',
      ]
    : [
        '',
        '### 0. Recall prior memory',
        'No memory plugin detected. Skipping recall step. If you have a memory plugin installed, surface it to the orchestrator so this step can be enabled.',
      ];
  return [
    `# brief-next — Phase 1 of 5: INPUTS`,
    `Ticket: ${ticket}`,
    `Tasks dir: ${tasksDir}`,
    '',
    ...memBlock,
    '',
    '### 1. Read your own ticket',
    `Open the ticket payload your previous workflow step fetched (typically under \`${path.join(tasksDir, 'ticket')}.{md,json}\` or surfaced in the previous step output). Read every field: title, description, acceptance criteria, comments. Take notes.`,
    '',
    '### 2. Read every linked ticket — FULL CONTENT, not just title',
    manifest
      ? `\`related-tickets.json\` lists ${linkedIds.length} linked ticket(s): ${linkedIds.join(', ') || '(none)'}. For EACH id, fetch the full description (jira/linear/gh) and save it to \`${path.join(tasksDir, '_related')}/<id>.md\`. Title is not enough — you must read the full body to detect overlaps in phase 2.`
      : 'No `related-tickets.json` found. Generate it first via the related-tickets-inject step or have the orchestrator regenerate it. This script will block until the manifest is present.',
    '',
    '### What I will check before advancing',
    `- \`${path.join(tasksDir, 'related-tickets.json')}\` exists`,
    `- For every linked ticket id, \`${path.join(tasksDir, '_related')}/<id>.md\` exists with at least 50 chars of body (title-only files are rejected)`,
    '',
    'When done, re-invoke me.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(BRIEF_PHASES.inputs, {
    next: BRIEF_PHASES.overlap,
    validate,
    instructions,
  });
};

// Exposed for tests.
module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.validateArtifacts = validateArtifacts;
