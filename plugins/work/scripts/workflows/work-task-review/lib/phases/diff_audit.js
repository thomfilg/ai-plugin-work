/**
 * Phase: diff_audit — compute the task-scoped diff via task-review-gate.js
 * and snapshot it for downstream phases. Records the diff range +
 * changed-file list into `task-review-context.json`.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { TASK_REVIEW_PHASES } = require('../../task-review-phase-registry');

let taskReviewGate;
try {
  taskReviewGate = require('../../../work/gates/task-review-gate');
} catch {
  taskReviewGate = null;
}

let config;
try {
  config = require('../../../lib/config');
} catch {
  config = null;
}

function resolveFallbackBase(ctx) {
  // Defer to config.getBaseBranch() so repos using `dev`/`master`/etc. work.
  // Mirrors work-pr-reviewer/lib/kind-checks/shared.js::resolveBaseCandidates.
  try {
    if (config && typeof config.getBaseBranch === 'function') {
      const b = config.getBaseBranch({ cwd: ctx.worktreeRoot || process.cwd() });
      if (b) return b;
    }
  } catch {
    /* fall through */
  }
  return 'origin/main';
}

function gitDiffNameOnly(base, head, cwd) {
  const r = spawnSync('git', ['diff', '--name-only', `${base}...${head}`], {
    cwd,
    encoding: 'utf8',
  });
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function computeDiff(ctx) {
  if (taskReviewGate && typeof taskReviewGate.computeTaskDiff === 'function') {
    try {
      return taskReviewGate.computeTaskDiff(ctx.tasksDir, ctx.ticket);
    } catch {
      /* fall through */
    }
  }
  return { base: resolveFallbackBase(ctx), head: 'HEAD', fallback: true };
}

function writeContext(ctx, diff, files) {
  const p = path.join(ctx.tasksDir, 'task-review-context.json');
  const payload = {
    ticket: ctx.ticket,
    base: diff.base,
    head: diff.head,
    fallback: !!diff.fallback,
    fileCount: files.length,
    files,
    capturedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(p, JSON.stringify(payload, null, 2));
  } catch {
    /* hook-gated; non-fatal */
  }
}

function validate(ctx) {
  const diff = computeDiff(ctx);
  const root = ctx.worktreeRoot || process.cwd();
  const files = gitDiffNameOnly(diff.base, diff.head, root);
  if (!files.length) {
    return {
      ok: false,
      errors: [
        `task diff empty for ${diff.base}...${diff.head}. Either nothing was committed for this task, or .last-commit-sha is stale. Re-record the SHA after committing.`,
      ],
    };
  }
  writeContext(ctx, diff, files);
  const warnings = diff.fallback
    ? [`Used fallback base "${diff.base}" — diff scope may exceed this task.`]
    : [];
  return {
    ok: true,
    warnings,
    summary: `${files.length} files in task diff (${diff.base}...${diff.head})`,
  };
}

function instructions(ctx) {
  return [
    '# task-review-next — Phase 2 of 8: DIFF AUDIT',
    `Ticket: ${ctx.ticket}`,
    '',
    "Computed via `task-review-gate.computeTaskDiff()` — only this task's commit range, not the whole branch.",
    'Diff snapshot recorded into `task-review-context.json` for downstream phases.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(TASK_REVIEW_PHASES.diff_audit, {
    next: TASK_REVIEW_PHASES.reuse_check,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.computeDiff = computeDiff;
module.exports.gitDiffNameOnly = gitDiffNameOnly;
