/**
 * Phase: validate — cross-check brief.md ↔ sibling-overlap.md.
 *
 * Every sibling-overlap.md section marked `sibling-owned` must appear in
 * brief.md's `Out of scope (sibling-owned)` section. This catches the
 * agent writing a verdict in one file but forgetting to land it in the
 * brief.
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

function sliceSection(text, headerRe) {
  const m = text.match(headerRe);
  if (!m) return null;
  const after = text.slice(m.index + m[0].length);
  const next = after.match(/^##\s/m);
  return next ? after.slice(0, next.index) : after;
}

function validateArtifacts(tasksDir, linkedIds) {
  const errors = [];
  const briefPath = path.join(tasksDir, 'brief.md');
  const overlapPath = path.join(tasksDir, 'sibling-overlap.md');
  const brief = readFile(briefPath);
  const overlap = readFile(overlapPath);
  if (!brief) errors.push(`Missing ${briefPath}.`);
  if (!overlap) errors.push(`Missing ${overlapPath}.`);
  if (!brief || !overlap) return errors;

  // Use lookahead instead of \b — `)` is non-word and the following char
  // (space/EOL) is also non-word, so \b never matches in JS regex. ECHO-4578
  // hit this: the section sliced to empty even when every sibling ID was
  // present, blocking validate indefinitely.
  const oos = sliceSection(brief, /^##\s+Out of scope\s*\(sibling-owned\)(?=\s|$)/im) || '';
  for (const id of linkedIds) {
    const headerRe = new RegExp(`^##\\s+${id}\\b`, 'm');
    const m = overlap.match(headerRe);
    if (!m) continue;
    const startIdx = m.index;
    const after = overlap.slice(startIdx);
    const nextHdr = after.slice(2).match(/^##\s/m);
    const section = nextHdr ? after.slice(0, nextHdr.index + 2) : after;
    const verdict = (section.match(/\*\*Verdict:\*\*\s*(sibling-owned|shared|no-overlap)/i) ||
      [])[1];
    if (verdict && verdict.toLowerCase() === 'sibling-owned') {
      if (!oos.includes(id)) {
        errors.push(
          `brief.md 'Out of scope (sibling-owned)' is missing ${id}, which sibling-overlap.md marks sibling-owned.`
        );
      }
    }
  }
  return errors;
}

function validate(ctx) {
  const errors = validateArtifacts(ctx.tasksDir, ctx.linkedIds);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, summary: 'cross-checks ok' };
}

function instructions(ctx) {
  const { ticket } = ctx;
  return [
    `# brief-next — Phase 4 of 5: VALIDATE`,
    `Ticket: ${ticket}`,
    '',
    '### What I check',
    `- \`brief.md\` has every required section.`,
    `- Every linked ticket marked \`sibling-owned\` in sibling-overlap.md is referenced in brief.md's \`Out of scope (sibling-owned)\`.`,
    '',
    'If validation passes, I record the phase and advance you to MEMORIZE. If it fails, I print the gaps and you fix them.',
    '',
    'Re-invoke me to run the check.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(BRIEF_PHASES.validate, {
    next: BRIEF_PHASES.memorize,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.validateArtifacts = validateArtifacts;
