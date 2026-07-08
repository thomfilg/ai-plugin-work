/**
 * Phase: validate_description — enforce required sections in pr-body.md.
 *
 * Sections:
 *  - `## Summary`
 *  - `## Test plan`
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
  return new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(?=\\s|$)`, 'im').test(
    text
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
  const errors = [];
  if (!hasSection(body, 'Summary')) errors.push('pr-body.md missing `## Summary` section.');
  if (!hasSection(body, 'Test plan')) errors.push('pr-body.md missing `## Test plan` section.');
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
    '- `## Summary` section is present',
    '- `## Test plan` section is present',
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
