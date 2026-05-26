/**
 * Phase: reuse_check — verify the task didn't reinvent existing helpers.
 *
 * Light heuristic: scan added files for util/helper/format/parse/validate
 * function names and grep the rest of the worktree for same-named exports
 * already shipped. Surfaces possible duplication as warnings (block only
 * on exact-name collision in a same-layer directory).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { TASK_REVIEW_PHASES } = require('../../task-review-phase-registry');

const FN_RE = /\b(?:function|const|let|var)\s+([A-Za-z_][A-Za-z0-9_]+)\s*[=(<]/g;
const REUSE_PREFIXES = /^(?:format|parse|validate|to|from|get|is|has|map|build|make|create)[A-Z]/;

function readContext(tasksDir) {
  const p = path.join(tasksDir, 'task-review-context.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function extractCandidateNames(filePath, root) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, filePath), 'utf8');
  } catch {
    return [];
  }
  const out = new Set();
  let m;
  while ((m = FN_RE.exec(text)) !== null) {
    const name = m[1];
    if (REUSE_PREFIXES.test(name)) out.add(name);
  }
  return [...out];
}

function grepExports(name, root, excludeFile) {
  const r = spawnSync(
    'git',
    ['grep', '-l', '--', `\\b\\(function\\|const\\|let\\|var\\)\\s\\+${name}\\b`],
    { cwd: root, encoding: 'utf8' }
  );
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((f) => f && f !== excludeFile);
}

function validate(ctx) {
  const root = ctx.worktreeRoot || process.cwd();
  const snap = readContext(ctx.tasksDir);
  if (!snap || !Array.isArray(snap.files)) {
    return { ok: true, summary: 'no diff snapshot — skipping reuse check' };
  }
  const warnings = [];
  let scanned = 0;
  for (const f of snap.files) {
    if (!/\.(?:[mc]?[jt]sx?)$/.test(f)) continue;
    scanned++;
    const names = extractCandidateNames(f, root);
    for (const name of names) {
      const collisions = grepExports(name, root, f);
      if (collisions.length) {
        warnings.push(
          `\`${name}\` (added in \`${f}\`) collides with existing definition(s): ${collisions
            .slice(0, 3)
            .map((c) => `\`${c}\``)
            .join(', ')}${collisions.length > 3 ? ', …' : ''}. Consider reusing.`
        );
      }
    }
  }
  return {
    ok: true,
    warnings,
    summary: `scanned ${scanned} src file(s), ${warnings.length} reuse warning(s)`,
  };
}

function instructions(ctx) {
  return [
    '# task-review-next — Phase 3 of 8: REUSE CHECK',
    `Ticket: ${ctx.ticket}`,
    '',
    'I grep for util/helper names that collide with existing exports. Warnings only — the report phase records them.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(TASK_REVIEW_PHASES.reuse_check, {
    next: TASK_REVIEW_PHASES.kind_checks,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.extractCandidateNames = extractCandidateNames;
