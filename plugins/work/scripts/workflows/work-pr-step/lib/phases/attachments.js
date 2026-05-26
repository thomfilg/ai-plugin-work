/**
 * Phase: attachments — if QA reports exist under `tasks/<ticket>/screenshots/`
 * or `qa-*.md`, ensure pr-body.md has a wiki link / section referencing them.
 *
 * Soft gate: if no QA artifacts exist, auto-pass.
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

function hasQAArtifacts(tasksDir) {
  const screenshotsDir = path.join(tasksDir, 'screenshots');
  const hasShots = fs.existsSync(screenshotsDir) && fs.readdirSync(screenshotsDir).length > 0;
  let hasQa = false;
  try {
    hasQa = fs.readdirSync(tasksDir).some((f) => /^qa-.*\.md$/i.test(f));
  } catch {
    /* empty */
  }
  return { hasShots, hasQa };
}

function validate(ctx) {
  const { hasShots, hasQa } = hasQAArtifacts(ctx.tasksDir);
  if (!hasShots && !hasQa) {
    return { ok: true, summary: 'no QA/screenshots — skipped' };
  }
  const body = readFile(path.join(ctx.tasksDir, 'pr-body.md')) || '';
  // Soft check: body should reference either a wiki/screenshots URL or
  // the screenshots/ directory.
  const ref = /screenshots|wiki|\/blob\/[^/]+\/screenshots/i.test(body);
  if (!ref) {
    return {
      ok: false,
      errors: [
        `QA artifacts exist (${hasShots ? 'screenshots' : ''}${hasShots && hasQa ? ' + ' : ''}${hasQa ? 'qa-*.md' : ''}) but pr-body.md does not reference them. Add a wiki link (run pr-post-generator) or mention the screenshots/ directory in the body.`,
      ],
    };
  }
  return { ok: true, summary: 'pr-body.md references QA artifacts' };
}

function instructions(ctx) {
  return [
    `# pr-next — Phase 6 of 8: ATTACHMENTS`,
    `Ticket: ${ctx.ticket}`,
    '',
    '### What I check',
    '- If `screenshots/` exists with files OR any `qa-*.md` files are in tasks dir:',
    '  → pr-body.md must reference them (wiki link, screenshots/ path, or qa report mention).',
    '- Otherwise auto-pass.',
    '',
    'Use the pr-post-generator agent (`Task(work-workflow:pr-post-generator)`) to upload screenshots to wiki and patch pr-body.md with the link.',
    '',
    'Re-invoke me to verify.',
    '',
  ].join('\n');
}

module.exports = function register(r) {
  r(PR_PHASES.attachments, {
    next: PR_PHASES.memorize,
    validate,
    instructions,
  });
};
module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.hasQAArtifacts = hasQAArtifacts;
