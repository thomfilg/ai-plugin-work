/**
 * Phase: description_draft — `pr-body.md` carries the PR description.
 *
 * The body itself can only come from whoever analysed the diff, so on a first
 * run the draft still arrives from the pr-generator agent's output and the
 * orchestrator saves it (the agent is read-only — see lib/pr-github.js).
 *
 * On a re-run against a branch that already has a PR, the body is already on
 * GitHub, and the runner seeds `pr-body.md` from it rather than blocking the
 * read-only agent on a write it cannot perform. That is the common case for
 * this phase: `/work-pr` is explicitly re-runnable, and the pr step re-enters
 * here after every new commit.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { PR_PHASES } = require('../../pr-phase-registry');
const { readPullRequest } = require('../pr-github');

const MIN_BODY_CHARS = 80;

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Write `pr-body.md` from the live PR description, when there is one with
 * enough substance to satisfy this gate.
 *
 * @returns {string|null} the seeded body, or null when nothing was written.
 */
function seedFromGitHub(ctx, bodyPath) {
  const pr = readPullRequest(ctx.worktreeRoot, ['body']);
  const body = pr && typeof pr.body === 'string' ? pr.body : '';
  if (body.trim().length < MIN_BODY_CHARS) return null;
  try {
    fs.writeFileSync(bodyPath, body.endsWith('\n') ? body : `${body}\n`);
    return body;
  } catch {
    return null;
  }
}

function validate(ctx) {
  const p = path.join(ctx.tasksDir, 'pr-body.md');
  let body = readFile(p);
  let seeded = false;
  if (!body || body.trim().length < MIN_BODY_CHARS) {
    const fromGitHub = seedFromGitHub(ctx, p);
    if (fromGitHub) {
      body = fromGitHub;
      seeded = true;
    }
  }
  if (!body) {
    return {
      ok: false,
      errors: [
        `Missing ${p}, and this branch has no PR to seed it from. Draft the PR description ` +
          `(the pr-generator agent's output IS the body) and save it to that path.`,
      ],
    };
  }
  if (body.trim().length < MIN_BODY_CHARS) {
    return {
      ok: false,
      errors: [`pr-body.md is too short (< ${MIN_BODY_CHARS} chars). Flesh out the description.`],
    };
  }
  return {
    ok: true,
    summary: seeded ? `${body.length} chars (seeded from the open PR)` : `${body.length} chars`,
  };
}

function instructions(ctx) {
  return [
    `# pr-next — Phase 3 of 8: DESCRIPTION DRAFT`,
    `Ticket: ${ctx.ticket}`,
    '',
    '### What I do',
    `- If this branch already has a PR, I seed \`${path.join(ctx.tasksDir, 'pr-body.md')}\` from ` +
      'its description with `gh pr view --json body`. Nothing for you to write.',
    '',
    '### What you do (first PR for this branch only)',
    `Produce the body and have it saved to \`${path.join(ctx.tasksDir, 'pr-body.md')}\`.`,
    '',
    'Suggested structure (validate_description phase will enforce):',
    '',
    '```markdown',
    '## Summary',
    '<1-3 bullets — what + why>',
    '',
    '## Test plan',
    '- [ ] <how to verify>',
    '',
    '## Linked tickets',
    '- ECHO-XXXX',
    '```',
    '',
    "Use the pr-generator agent (`Task(work-workflow:pr-generator)`) to draft from the diff — that's the canonical path. Its output IS the body.",
    'The pr-generator is read-only and cannot save the file itself: the orchestrator that dispatched it writes the output to `pr-body.md`.',
    '',
  ].join('\n');
}

module.exports = function register(r) {
  r(PR_PHASES.description_draft, {
    next: PR_PHASES.validate_description,
    validate,
    instructions,
  });
};
module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.seedFromGitHub = seedFromGitHub;
module.exports.MIN_BODY_CHARS = MIN_BODY_CHARS;
