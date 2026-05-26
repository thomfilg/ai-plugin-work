/**
 * Phase: diff_audit — verify the branch diff vs base is non-empty and
 * records the changed-file list into `pr-context.json` for downstream
 * phases to consume.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { PR_PHASES } = require('../../pr-phase-registry');

function git(args, cwd) {
  const r = spawnSync('git', args, { encoding: 'utf8', cwd });
  return { code: r.status ?? -1, out: (r.stdout || '').trim() };
}

function resolveBase(worktreeRoot) {
  // Use the canonical config.getBaseBranch() which honors the full priority
  // chain: $BASE_BRANCH env → git symbolic-ref → probe origin/main, dev,
  // master → fallback. Repos using `dev` or `master` as default would
  // otherwise always fail diff_audit with "Cannot resolve a base branch."
  try {
    const config = require('../../../lib/config');
    if (typeof config.getBaseBranch === 'function') {
      const base = config.getBaseBranch({ cwd: worktreeRoot });
      if (base) return base;
    }
  } catch {
    /* fall through to legacy probe */
  }
  // Legacy fallback: probe origin/main, main directly.
  if (git(['rev-parse', '--verify', '--quiet', 'origin/main'], worktreeRoot).code === 0)
    return 'origin/main';
  if (git(['rev-parse', '--verify', '--quiet', 'main'], worktreeRoot).code === 0) return 'main';
  return null;
}

function listChangedFiles(worktreeRoot) {
  const base = resolveBase(worktreeRoot);
  if (!base) return { base: null, files: [] };
  const r = git(['diff', '--name-only', `${base}...HEAD`], worktreeRoot);
  if (r.code !== 0) return { base, files: [] };
  const files = r.out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return { base, files };
}

const CTX_FILE = 'pr-context.json';

function validate(ctx) {
  const { worktreeRoot, tasksDir } = ctx;
  const { base, files } = listChangedFiles(worktreeRoot);
  if (!base) {
    return { ok: false, errors: ['Cannot resolve a base branch (origin/main or main).'] };
  }
  if (!files.length) {
    return {
      ok: false,
      errors: [
        `No files changed vs \`${base}\`. The branch has nothing to ship — either commit your changes or rebase.`,
      ],
    };
  }
  try {
    fs.writeFileSync(
      path.join(tasksDir, CTX_FILE),
      JSON.stringify({ base, files, snapshotAt: new Date().toISOString() }, null, 2)
    );
  } catch {
    /* hook-gated; non-fatal */
  }
  return { ok: true, summary: `${files.length} file(s) changed vs ${base}` };
}

function instructions(ctx) {
  return [
    `# pr-next — Phase 2 of 8: DIFF AUDIT`,
    `Ticket: ${ctx.ticket}`,
    '',
    '### What I do',
    '- Resolve base branch (`origin/main` preferred, fallback `main`).',
    `- List changed files via \`git diff --name-only <base>...HEAD\`.`,
    `- Persist the snapshot into \`${CTX_FILE}\` for the downstream phases.`,
    '',
    'If the diff is empty, commit your work or rebase off `main`.',
    '',
  ].join('\n');
}

module.exports = function register(r) {
  r(PR_PHASES.diff_audit, {
    next: PR_PHASES.description_draft,
    validate,
    instructions,
  });
};
module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.listChangedFiles = listChangedFiles;
module.exports.resolveBase = resolveBase;
module.exports.CTX_FILE = CTX_FILE;
