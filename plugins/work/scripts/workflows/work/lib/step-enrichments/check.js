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
const fs = require('fs');
const { execFileSync } = require('child_process');

const { parseTasks } = require(path.join('..', '..', '..', 'work', 'lib', 'task-parser'));
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

/**
 * List the COMMITTED branch diff inside the ticket worktree.
 *
 * ECHO-5148/5719/5807/5816/5818/5821: this used to run in ctx.workDir — the
 * PLUGIN's own checkout — so the "unaccounted" list was hundreds of
 * plugins/work/... files that don't exist in the app worktree. The diff MUST
 * be executed against the ticket worktree (`git -C <worktree>`), with the
 * base branch resolved from that worktree's repo config, never the
 * orchestrator's cwd.
 *
 * ECHO-5325: uses `git diff --name-only <base>...HEAD` (committed diff only)
 * — never `git status` / working-tree state — so untracked local artifacts
 * (editor backups, logs) are never counted as "unaccounted".
 *
 * @param {string} worktreeDir - Absolute path to the ticket worktree
 * @param {Function} [exec] - execFileSync-compatible injectable (tests)
 * @returns {{files: string[]}|{files: null, reason: string}}
 */
function gitDiffFiles(worktreeDir, exec = execFileSync) {
  // Use the shared base-candidate resolver so check, code-checker, and
  // completion-checker all pick the same base ref. Honors BASE_BRANCH env
  // and the WORKTREE's git symbolic-ref; falls back to origin/main.
  const candidates = config.getDiffBaseCandidates({ cwd: worktreeDir });
  for (const ref of candidates) {
    try {
      const out = exec('git', ['-C', worktreeDir, 'diff', '--name-only', `${ref}...HEAD`], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      return {
        files: out
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      };
    } catch {
      /* try next ref */
    }
  }
  return {
    files: null,
    reason: `git diff failed in ${worktreeDir} for base candidate(s) ${candidates.join(', ')}`,
  };
}

/**
 * Build the scope-diff block for the check2 delegate prompt.
 *
 * @param {string} tasksDir
 * @param {string|undefined} worktreeDir - Canonical ticket worktree path
 * @param {{exec?: Function, fs?: object}} [deps] - Injectables for tests
 * @returns {null|{kind:'summary',text:string}|{kind:'unavailable',reason:string}}
 */
/** Parsed tasks with scope declarations, or null (absent/empty/unparseable). */
function loadScopedTasks(tasksDir) {
  try {
    const tasks = parseTasks(tasksDir);
    return tasks && tasks.length > 0 ? tasks : null;
  } catch {
    return null;
  }
}

/**
 * Never fall back to the orchestrator's cwd / plugin checkout: if the
 * worktree can't be resolved, say so instead of diffing the wrong repo.
 * Returns the `unavailable` block, or null when the worktree is usable.
 */
function worktreeUnavailableBlock(worktreeDir, fsMod) {
  if (worktreeDir && fsMod.existsSync(worktreeDir)) return null;
  return {
    kind: 'unavailable',
    reason: worktreeDir
      ? `worktree directory not found: ${worktreeDir}`
      : 'ticket worktree path could not be resolved',
  };
}

function buildScopeDiffBlock(tasksDir, worktreeDir, deps = {}) {
  const tasks = loadScopedTasks(tasksDir);
  if (!tasks) return null;

  const unavailable = worktreeUnavailableBlock(worktreeDir, deps.fs || fs);
  if (unavailable) return unavailable;

  const diff = gitDiffFiles(worktreeDir, deps.exec);
  if (!diff.files) return { kind: 'unavailable', reason: diff.reason };

  const result = compareDiffToScope(diff.files, tasks);
  if (result.totals.total === 0) return null;
  return { kind: 'summary', text: summarizeScopeDiff(result) };
}

function registerCheck(register) {
  register('check', (entry, ctx) => {
    entry.agentType = 'skill';
    entry.agentPrompt = `/work-workflow:check2 ${ctx.ticket || 'TICKET'}`;

    // Gate E — append scope-diff summary as additional context for the
    // completion-checker that runs inside /check2. The diff is computed in
    // the ticket worktree (ctx.worktreeDir), NOT ctx.workDir (the plugin's
    // own checkout) — see gitDiffFiles docblock.
    const block = buildScopeDiffBlock(ctx.tasksDir, ctx.worktreeDir);
    if (block && block.kind === 'summary') {
      entry.agentPrompt = `${entry.agentPrompt}\n\n${block.text}\n\nGate E: surface any sibling-owned or unaccounted files in the PR body. Sibling-owned changes must be reverted or escalated to the owning ticket — do NOT ship them in this PR.`;
    } else if (block && block.kind === 'unavailable') {
      entry.agentPrompt = `${entry.agentPrompt}\n\n## Scope-diff summary\n\nscope-diff unavailable: ${block.reason}\n\nGate E: verify the branch diff manually inside the ticket worktree (\`git diff --name-only origin/<base>...HEAD\`) and surface any sibling-owned or unaccounted files in the PR body.`;
    }
  });
}

module.exports = registerCheck;
module.exports.buildBaseCandidates = buildBaseCandidates;
module.exports.gitDiffFiles = gitDiffFiles;
module.exports.buildScopeDiffBlock = buildScopeDiffBlock;
