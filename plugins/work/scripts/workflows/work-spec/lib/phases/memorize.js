/**
 * Phase: memorize — persist key spec decisions to the memory plugin.
 *
 * If a memory plugin is detected, the agent must save the verified surface
 * + key architecture decisions so future tickets can recall them. We gate
 * on a sentinel line `<!-- spec-memorized -->` in spec.md as a cheap
 * acknowledgement that the save happened.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { SPEC_PHASES } = require('../../spec-phase-registry');

const SENTINEL = '<!-- spec-memorized -->';

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function validate(ctx) {
  if (!ctx.memory) {
    return { ok: true, summary: 'no memory plugin detected — auto-passing memorize' };
  }
  const spec = readFile(path.join(ctx.tasksDir, 'spec.md'));
  if (!spec) {
    return { ok: false, errors: [`Missing spec.md.`] };
  }
  if (!spec.includes(SENTINEL)) {
    return {
      ok: false,
      errors: [
        `spec.md is missing the memorize sentinel \`${SENTINEL}\`. After calling \`${ctx.memory.rememberTool}\` (and \`${ctx.memory.saveTool || '(no save tool)'}\`) to persist the verified surface + architecture decisions, append \`${SENTINEL}\` to spec.md as confirmation.`,
      ],
    };
  }
  return { ok: true, summary: 'spec decisions memorized' };
}

function instructions(ctx) {
  const { ticket, memory } = ctx;
  if (!memory) {
    return [
      `# spec-next — Phase 6 of 8: MEMORIZE`,
      `Ticket: ${ticket}`,
      '',
      'No memory plugin detected. Auto-advancing.',
      '',
    ].join('\n');
  }
  return [
    `# spec-next — Phase 6 of 8: MEMORIZE (${memory.name})`,
    `Ticket: ${ticket}`,
    '',
    '### What you do',
    `Call \`${memory.rememberTool}\` (and \`${memory.saveTool || '(no save tool)'}\` if a save step is required) with at least these items:`,
    `- The \`## Verified sibling surface\` block from spec.md (file::identifier pairs).`,
    `- Each \`## Architecture Decisions\` bullet (so future siblings know why this ticket made the trade-offs it did).`,
    `- The Reuse Audit hits and explicit misses.`,
    '',
    `When the save call(s) return success, append \`${SENTINEL}\` to the end of spec.md as confirmation.`,
    '',
    '### What I will check before advancing',
    `- spec.md ends with (or contains) \`${SENTINEL}\``,
    '',
    'Re-invoke me to verify.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(SPEC_PHASES.memorize, {
    next: SPEC_PHASES.kind_checks,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.SENTINEL = SENTINEL;
