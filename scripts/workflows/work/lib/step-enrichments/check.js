/**
 * Check step enrichment.
 *
 * - Rewrites the check step to invoke /check2 skill instead of the old /check skill.
 * - Gate E: injects a scope-diff summary into the agent prompt comparing the
 *   current git diff against the union of every task's `### Files in scope`.
 *   Surfaces sibling-owned and unaccounted files for the completion-checker
 *   to either justify in the PR or revert before progressing.
 */

'use strict';

const path = require('path');
const { execSync } = require('child_process');

const { parseTasks } = require(path.join('..', '..', '..', 'work', 'task-parser'));
const { compareDiffToScope, summarizeScopeDiff } = require('../../../lib/scope-diff');
const config = require('../../../lib/config');

/**
 * Build ordered diff-base candidates from a base branch value. Handles the
 * case where the input already starts with `origin/` (ECHO-4450 reproducer
 * was `origin/origin/main...HEAD` from double-prefixing). Deduped + ordered:
 * remote ref first, bare second.
 */
function buildBaseCandidates(base) {
  const bare = String(base || 'main').replace(/^origin\//, '');
  return [...new Set([`origin/${bare}`, bare])];
}

function gitDiffFiles(workDir) {
  // Use the shared base-candidate resolver so check, code-checker, and
  // completion-checker all pick the same base ref. Honors BASE_BRANCH env
  // and git symbolic-ref; falls back to origin/main.
  const candidates = config.getDiffBaseCandidates({ cwd: workDir });
  for (const ref of candidates) {
    try {
      const out = execSync(`git diff --name-only ${ref}...HEAD`, {
        cwd: workDir,
        encoding: 'utf8',
        timeout: 10_000,
      });
      return out
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      /* try next ref */
    }
  }
  return null;
}

function buildScopeDiffBlock(tasksDir, workDir) {
  let tasks = null;
  try {
    tasks = parseTasks(tasksDir);
  } catch {
    return null;
  }
  if (!tasks || tasks.length === 0) return null;

  const files = gitDiffFiles(workDir);
  if (!files) return null;

  const result = compareDiffToScope(files, tasks);
  if (result.totals.total === 0) return null;
  return summarizeScopeDiff(result);
}

function registerCheck(register) {
  register('check', (entry, ctx) => {
    entry.agentType = 'skill';
    entry.agentPrompt = `/work-workflow:check2 ${ctx.ticket || 'TICKET'}`;

    // Gate E — append scope-diff summary as additional context for the
    // completion-checker that runs inside /check2.
    const block = buildScopeDiffBlock(ctx.tasksDir, ctx.workDir);
    if (block) {
      entry.agentPrompt = `${entry.agentPrompt}\n\n${block}\n\nGate E: surface any sibling-owned or unaccounted files in the PR body. Sibling-owned changes must be reverted or escalated to the owning ticket — do NOT ship them in this PR.`;
    }
  });
}

module.exports = registerCheck;
module.exports.buildBaseCandidates = buildBaseCandidates;
