/**
 * Phase: pr_context — capture PR metadata (number, base, files) into
 * `pr-review-context.json` for downstream phases. Agent runs gh and writes
 * the snapshot; gate validates the snapshot has number + files.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { PR_REVIEW_PHASES } = require('../../pr-review-phase-registry');

const CTX_FILE = 'pr-review-context.json';

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function validate(ctx) {
  const p = path.join(ctx.tasksDir, CTX_FILE);
  const j = readJson(p);
  if (!j) {
    return {
      ok: false,
      errors: [
        `Missing ${p}. Run \`gh pr view <N> --json number,headRefName,baseRefName,files\` and save the relevant fields here (with \`files\` flattened to an array of paths).`,
      ],
    };
  }
  if (typeof j.number !== 'number' && typeof j.number !== 'string') {
    return { ok: false, errors: [`${CTX_FILE} must include a \`number\` field (PR number).`] };
  }
  if (!Array.isArray(j.files) || j.files.length === 0) {
    return {
      ok: false,
      errors: [`${CTX_FILE} must include a non-empty \`files\` array of paths in the PR diff.`],
    };
  }
  return { ok: true, summary: `PR #${j.number}, ${j.files.length} file(s)` };
}

function instructions(ctx) {
  return [
    '# pr-review-next — Phase 2 of 8: PR CONTEXT',
    `Ticket: ${ctx.ticket}`,
    '',
    `Write \`${path.join(ctx.tasksDir, CTX_FILE)}\` with PR metadata. Suggested shape:`,
    '',
    '```json',
    '{',
    '  "number": 1234,',
    '  "headRefName": "feature/echo-xxxx",',
    '  "baseRefName": "main",',
    '  "files": ["path/a.tsx", "path/b.ts"]',
    '}',
    '```',
    '',
    'Use `gh pr view <N> --json number,headRefName,baseRefName,files` and flatten `files[].path` into a string array.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(PR_REVIEW_PHASES.pr_context, {
    next: PR_REVIEW_PHASES.diff_audit,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.CTX_FILE = CTX_FILE;
