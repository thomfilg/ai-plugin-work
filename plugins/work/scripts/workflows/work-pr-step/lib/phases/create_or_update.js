/**
 * Phase: create_or_update — agent runs `gh pr create` or `gh pr edit` with
 * pr-body.md; this phase records the resulting PR into `pr-context.json`.
 *
 * The recording used to be the agent's job ("Patch pr-context.json with
 * { prNumber, url }"), which the read-only `pr-generator` driving this runner
 * cannot do — it has no Write tool and its guard blocks every shell redirect.
 * The runner does it instead, reading the PR back with `gh pr view`, the same
 * way `diff_audit` writes its own snapshot. `gh pr create` stays with the
 * agent: the guard already allows `gh`.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { PR_PHASES } = require('../../pr-phase-registry');
const { readPullRequest } = require('../pr-github');

const CTX_FILE = 'pr-context.json';

function contextPath(tasksDir) {
  return path.join(tasksDir, CTX_FILE);
}

function readContext(tasksDir) {
  try {
    return JSON.parse(fs.readFileSync(contextPath(tasksDir), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Merge `{prNumber, url}` into pr-context.json.
 *
 * @returns {boolean} true when the file now records them.
 */
function recordPr(tasksDir, pctx, pr) {
  const merged = { ...pctx, prNumber: pr.number, url: pr.url || pctx.url || null };
  try {
    fs.writeFileSync(contextPath(tasksDir), JSON.stringify(merged, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Fill in prNumber/url from the live PR when the context does not have them.
 *
 * @returns {object|null} the context with the PR recorded, or null when there
 *   is no PR to record (or it could not be written).
 */
function syncFromGitHub(ctx, pctx) {
  const pr = readPullRequest(ctx.worktreeRoot, ['number', 'url', 'state']);
  if (!pr || typeof pr.number !== 'number' || pr.number <= 0) return null;
  if (!recordPr(ctx.tasksDir, pctx, pr)) return null;
  return { ...pctx, prNumber: pr.number, url: pr.url || pctx.url || null };
}

function validate(ctx) {
  let pctx = readContext(ctx.tasksDir);
  if (!pctx) return { ok: false, errors: [`Missing pr-context.json (re-run diff_audit).`] };
  if (!pctx.prNumber || typeof pctx.prNumber !== 'number') {
    pctx = syncFromGitHub(ctx, pctx) || pctx;
  }
  if (!pctx.prNumber || typeof pctx.prNumber !== 'number') {
    return {
      ok: false,
      errors: [
        `No pull request found for this branch. Run \`gh pr create --title "..." --body-file ${path.join(
          ctx.tasksDir,
          'pr-body.md'
        )}\` (or \`gh pr edit <NUMBER> --body-file ...\` if one already exists), then re-invoke me — I read the PR back with \`gh pr view\` and record it in ${CTX_FILE} myself.`,
      ],
    };
  }
  return { ok: true, summary: `PR #${pctx.prNumber} recorded` };
}

function instructions(ctx) {
  return [
    `# pr-next — Phase 5 of 8: CREATE OR UPDATE`,
    `Ticket: ${ctx.ticket}`,
    '',
    '### What you do',
    `1. Read pr-body.md from ${path.join(ctx.tasksDir, 'pr-body.md')}.`,
    '2. Determine create vs update: `gh pr view --json number 2>/dev/null | jq -r .number` returns the existing PR number if any.',
    `3. Create: \`gh pr create --title "..." --body-file ${path.join(ctx.tasksDir, 'pr-body.md')}\``,
    `   OR update: \`gh pr edit <NUMBER> --body-file ${path.join(ctx.tasksDir, 'pr-body.md')}\``,
    '',
    '### What I do',
    `- Read the PR back with \`gh pr view\` and record \`prNumber\` + \`url\` into ${CTX_FILE}.`,
    '  You do NOT need to write that file — I own it.',
    '',
    'Re-invoke me once the PR exists.',
    '',
  ].join('\n');
}

module.exports = function register(r) {
  r(PR_PHASES.create_or_update, {
    next: PR_PHASES.attachments,
    validate,
    instructions,
  });
};
module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.recordPr = recordPr;
module.exports.syncFromGitHub = syncFromGitHub;
module.exports.CTX_FILE = CTX_FILE;
