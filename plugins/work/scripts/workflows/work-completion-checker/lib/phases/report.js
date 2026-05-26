/**
 * Phase: report — confirm completion.check.md was actually produced and
 * matches the canonical structure (Original Request, Deliverables Checklist,
 * Final Status). Agent writes the file; this phase only gates the artifact.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { COMPLETION_PHASES } = require('../../completion-phase-registry');

const REQUIRED_SECTIONS = ['Requirements Verification', 'Deliverables Checklist', 'Final Status'];

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function validate(ctx) {
  const p = path.join(ctx.tasksDir, 'completion.check.md');
  const text = readFile(p);
  if (!text) {
    return {
      ok: false,
      errors: [`Missing ${p}. Write the completion report there.`],
    };
  }
  const missing = REQUIRED_SECTIONS.filter((s) => !text.includes(s));
  if (missing.length) {
    return {
      ok: false,
      errors: [
        `completion.check.md is missing required section(s): ${missing.join(', ')}. Match the structure in agents/completion-checker.md.`,
      ],
    };
  }
  if (/\[INCOMPLETE/i.test(text)) {
    return {
      ok: false,
      errors: [
        'completion.check.md final status reads INCOMPLETE. Resolve the missing deliverables before advancing.',
      ],
    };
  }
  return { ok: true, summary: `${text.length} chars, all required sections present` };
}

function instructions(ctx) {
  return [
    '# completion-next — Phase 6 of 8: REPORT',
    `Ticket: ${ctx.ticket}`,
    '',
    `Write \`${path.join(ctx.tasksDir, 'completion.check.md')}\` with the canonical structure from agents/completion-checker.md:`,
    '',
    '```markdown',
    '## Requirements Verification',
    '',
    '### Original Request:',
    '...',
    '',
    '### Deliverables Checklist:',
    '- [x] Requirement 1 - DELIVERED: <code citation>',
    '',
    '### Final Status:',
    '[COMPLETE]',
    '```',
    '',
    'If you arrive at INCOMPLETE, you must NOT advance — fix the deliverables and re-invoke me.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(COMPLETION_PHASES.report, {
    next: COMPLETION_PHASES.memorize,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.REQUIRED_SECTIONS = REQUIRED_SECTIONS;
