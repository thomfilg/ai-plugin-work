/**
 * Phase: overlap — sibling-overlap.md with verdicts per linked ticket.
 *
 * The agent reads each `_related/<id>.md` and writes a verdict per linked
 * ticket: `sibling-owned | shared | no-overlap`. We validate the file
 * exists, has a `## <id>` section per linked ticket, and each section
 * carries the canonical `**Verdict:** ...` line.
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

function validateArtifacts(tasksDir, linkedIds) {
  const errors = [];
  const f = path.join(tasksDir, 'sibling-overlap.md');
  const c = readFile(f);
  if (!c) {
    errors.push(`Missing ${f}.`);
    return errors;
  }
  for (const id of linkedIds) {
    const headerRe = new RegExp(`^##\\s+${id}\\b`, 'm');
    if (!headerRe.test(c)) {
      errors.push(`sibling-overlap.md is missing section for ${id} (expected '## ${id}').`);
      continue;
    }
    const startIdx = c.match(headerRe).index;
    const after = c.slice(startIdx);
    const nextHdr = after.slice(2).match(/^##\s/m);
    const section = nextHdr ? after.slice(0, nextHdr.index + 2) : after;
    if (!/\*\*Verdict:\*\*\s*(sibling-owned|shared|no-overlap)\b/i.test(section)) {
      errors.push(
        `sibling-overlap.md section for ${id} missing '**Verdict:** sibling-owned|shared|no-overlap'.`
      );
    }
  }
  return errors;
}

function validate(ctx) {
  const errors = validateArtifacts(ctx.tasksDir, ctx.linkedIds);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, summary: `siblings=${ctx.linkedIds.length}` };
}

function instructions(ctx) {
  const { ticket, tasksDir, linkedIds } = ctx;
  const overlapPath = path.join(tasksDir, 'sibling-overlap.md');
  return [
    `# brief-next — Phase 2 of 5: OVERLAP`,
    `Ticket: ${ticket}`,
    '',
    '### Task',
    `Read every file in \`${path.join(tasksDir, '_related')}/\`. For each linked ticket (${linkedIds.length}), decide whether your ticket overlaps with theirs in any surface: file paths, tRPC procedures, schemas, components, endpoints, DB tables, environment variables, or product flows.`,
    '',
    `Write \`${overlapPath}\` in this exact format:`,
    '',
    '```markdown',
    '# Sibling Overlap Analysis',
    '',
    '## <TICKET-ID> — <title>',
    '**Verdict:** sibling-owned | shared | no-overlap',
    '**Surfaces:** comma-separated list of overlapping surfaces (file paths, procedures, schemas...)',
    '**Notes:** one-to-three sentence rationale, citing specific lines/paragraphs from the sibling description that informed the verdict.',
    '',
    '## <NEXT-TICKET-ID> — ...',
    '...',
    '```',
    '',
    '### Verdict semantics',
    "- **sibling-owned** — the surface is theirs; you must put it in your brief's `## Out of scope (sibling-owned)` and not implement it.",
    '- **shared** — both tickets touch it; coordination required. Note who owns the change.',
    '- **no-overlap** — different concerns; no risk of stepping on each other.',
    '',
    '### What I will check before advancing',
    `- \`${overlapPath}\` exists`,
    `- One \`## <TICKET-ID>\` section per linked ticket (${linkedIds.length} sections)`,
    `- Each section has a \`**Verdict:**\` line with one of the three values`,
    '',
    'When done, re-invoke me.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(BRIEF_PHASES.overlap, {
    next: BRIEF_PHASES.draft,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.validateArtifacts = validateArtifacts;
