/**
 * Phase: review_post — verify pr-review.check.md has the canonical
 * structure and a final verdict (APPROVE / REQUEST_CHANGES / COMMENT).
 *
 * Note: this phase only checks the LOCAL artifact. Posting the review to
 * GitHub (via `gh pr review`) is the agent's responsibility — we record
 * a sentinel `.pr-review-posted` to confirm it happened.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { PR_REVIEW_PHASES } = require('../../pr-review-phase-registry');

const REQUIRED_SECTIONS = ['Summary', 'PR-review kind verification', 'Verdict'];
const SENTINEL = '.pr-review-posted';

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function validate(ctx) {
  const p = path.join(ctx.tasksDir, 'pr-review.check.md');
  const text = readFile(p);
  if (!text) return { ok: false, errors: [`Missing ${p}.`] };
  const missing = REQUIRED_SECTIONS.filter((s) => !text.includes(s));
  if (missing.length) {
    return {
      ok: false,
      errors: [`pr-review.check.md missing section(s): ${missing.join(', ')}.`],
    };
  }
  if (!/Verdict:\s*(APPROVE|REQUEST_CHANGES|COMMENT)\b/i.test(text)) {
    return {
      ok: false,
      errors: [
        'pr-review.check.md final `Verdict:` line must be `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`.',
      ],
    };
  }
  const sentinel = path.join(ctx.tasksDir, SENTINEL);
  if (!fs.existsSync(sentinel)) {
    return {
      ok: false,
      errors: [
        `Post the review to GitHub with \`gh pr review <N> --<verdict-flag>\` (or web UI), then \`touch ${sentinel}\` to advance.`,
      ],
    };
  }
  return { ok: true, summary: `${text.length} chars, posted` };
}

function instructions(ctx) {
  return [
    '# pr-review-next — Phase 6 of 8: REVIEW POST',
    `Ticket: ${ctx.ticket}`,
    '',
    `1. Finalize \`${path.join(ctx.tasksDir, 'pr-review.check.md')}\` with sections: Summary, PR-review kind verification, Verdict.`,
    '2. End with a single line: `Verdict: APPROVE` | `REQUEST_CHANGES` | `COMMENT`.',
    '3. Post the review to GitHub:',
    '   - APPROVE: `gh pr review <N> --approve --body-file pr-review.check.md`',
    '   - REQUEST_CHANGES: `gh pr review <N> --request-changes --body-file pr-review.check.md`',
    '   - COMMENT: `gh pr review <N> --comment --body-file pr-review.check.md`',
    `4. \`touch ${path.join(ctx.tasksDir, SENTINEL)}\`.`,
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(PR_REVIEW_PHASES.review_post, {
    next: PR_REVIEW_PHASES.memorize,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.REQUIRED_SECTIONS = REQUIRED_SECTIONS;
module.exports.SENTINEL = SENTINEL;
