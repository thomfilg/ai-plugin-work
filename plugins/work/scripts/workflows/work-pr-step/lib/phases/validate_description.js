/**
 * Phase: validate_description — enforce required sections in pr-body.md.
 *
 * Two required sections, each accepting the spellings the plugin actually
 * emits:
 *  - overview:  `## Summary` or `## Existing Behavior`
 *  - test plan: `## Test plan` or `## Testing Plan` (matches `## Testing Plan / Demo`)
 *
 * The alternates are not cosmetic. `agents/pr-generator.md`'s own TEMPLATE TO
 * COMPLETE emits `## Existing Behavior` … `## Testing Plan / Demo`, while this
 * gate used to demand `## Summary` and `## Test plan` literally — and
 * `## Testing Plan / Demo` can never match `Test plan`, because "Test" is
 * followed by "ing" rather than whitespace. The gate therefore rejected every
 * PR body the plugin's own template produced. `description_draft`'s suggested
 * structure uses the `Summary`/`Test plan` spelling, so both are accepted
 * rather than picking a winner and invalidating existing bodies.
 *
 * Plus a content-aware check: if the diff (from pr-context.json) touches
 * UI files (`*.tsx`/`*.jsx`/`components/`), require a `## Screenshots`
 * section in pr-body.md.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { PR_PHASES } = require('../../pr-phase-registry');

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function hasSection(text, name) {
  return new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'im').test(
    text
  );
}

// Accepted spellings per required section. The FIRST entry is the canonical
// one quoted in the error message; the rest are what the pr-generator template
// and the description_draft skeleton actually emit.
const REQUIRED_SECTIONS = Object.freeze([
  Object.freeze({ id: 'summary', accepts: Object.freeze(['Summary', 'Existing Behavior']) }),
  Object.freeze({ id: 'test plan', accepts: Object.freeze(['Test plan', 'Testing Plan']) }),
]);

/** True when `text` carries any of the accepted spellings for a section. */
function hasAnySection(text, names) {
  return names.some((n) => hasSection(text, n));
}

/** One error per required section the body is missing, empty when all present. */
function missingSectionErrors(body) {
  return REQUIRED_SECTIONS.filter((s) => !hasAnySection(body, s.accepts)).map(
    (s) =>
      `pr-body.md missing a ${s.id} section — expected one of ${s.accepts
        .map((n) => `\`## ${n}\``)
        .join(' or ')}.`
  );
}

function readContext(tasksDir) {
  try {
    return JSON.parse(readFile(path.join(tasksDir, 'pr-context.json')));
  } catch {
    return null;
  }
}

function touchesUI(files) {
  return (files || []).some((f) => /\.(tsx|jsx)$/.test(f) || /(^|\/)components\//.test(f));
}

function validate(ctx) {
  const body = readFile(path.join(ctx.tasksDir, 'pr-body.md'));
  if (!body) return { ok: false, errors: [`Missing pr-body.md (re-run description_draft).`] };
  const errors = missingSectionErrors(body);
  const pctx = readContext(ctx.tasksDir);
  if (pctx && touchesUI(pctx.files) && !hasSection(body, 'Screenshots')) {
    errors.push(
      'Diff touches UI files (`*.tsx`/`*.jsx` or `components/`); pr-body.md must have a `## Screenshots` section (add `[needs screenshots]` placeholder if not yet captured).'
    );
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, summary: 'required sections present' };
}

function instructions(ctx) {
  return [
    `# pr-next — Phase 4 of 8: VALIDATE DESCRIPTION`,
    `Ticket: ${ctx.ticket}`,
    '',
    '### What I check',
    ...REQUIRED_SECTIONS.map(
      (s) => `- a ${s.id} section: ${s.accepts.map((n) => `\`## ${n}\``).join(' or ')}`
    ),
    '- If diff touches UI: `## Screenshots` section is present (placeholder OK)',
    '',
    'Re-invoke me to verify.',
    '',
  ].join('\n');
}

module.exports = function register(r) {
  r(PR_PHASES.validate_description, {
    next: PR_PHASES.create_or_update,
    validate,
    instructions,
  });
};
module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.touchesUI = touchesUI;
module.exports.hasSection = hasSection;
module.exports.hasAnySection = hasAnySection;
module.exports.missingSectionErrors = missingSectionErrors;
module.exports.REQUIRED_SECTIONS = REQUIRED_SECTIONS;
