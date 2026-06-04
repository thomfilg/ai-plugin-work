/**
 * Kind: devops — per-task review for CI/infra changes.
 *
 * Risk lens (per-task): secret-shaped strings, unpinned action refs,
 * accidental drift into `app/`, `lib/`, `components/`.
 */

'use strict';

const { readChangedFiles, isDevopsFile, detectKinds, readFileFromWorktree } = require('./shared');

const SECRET_RE = /(?:AWS|GH|GITHUB|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY)\s*[:=]\s*["'][^"']{16,}/i;
const UNPINNED_RE = /^\s*-?\s*uses:\s*[\w./-]+@(?:main|master|latest|v\d+)\s*$/m;
const APP_SOURCE_RE = /^(?:app|lib|components|src)\//;

function appliesTo(ctx) {
  if (detectKinds(ctx.tasksDir).includes('devops')) return true;
  return readChangedFiles(ctx).some(isDevopsFile);
}

function validate(ctx) {
  const changed = readChangedFiles(ctx);
  const ops = changed.filter(isDevopsFile);
  const errors = [];
  const warnings = [];

  for (const f of ops) {
    const text = readFileFromWorktree(ctx, f) || '';
    if (SECRET_RE.test(text)) {
      errors.push(`\`${f}\` contains a secret-shaped literal — move to repo secrets.`);
    }
    if (UNPINNED_RE.test(text)) {
      warnings.push(`\`${f}\` references an unpinned action ref (main/master/latest/vN).`);
    }
  }

  const drift = changed.filter((f) => APP_SOURCE_RE.test(f));
  if (ops.length && drift.length) {
    warnings.push(
      `DevOps task also touches app source: ${drift
        .slice(0, 3)
        .map((f) => `\`${f}\``)
        .join(', ')}. Confirm cross-kind scope is intended.`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${ops.length} devops file(s) reviewed`,
  };
}

module.exports = function register(registerKind) {
  registerKind('devops', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
module.exports.SECRET_RE = SECRET_RE;
module.exports.UNPINNED_RE = UNPINNED_RE;
