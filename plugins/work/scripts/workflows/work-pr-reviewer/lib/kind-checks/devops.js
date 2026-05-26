/**
 * Kind: devops — PR review for infra / CI changes.
 *
 * Risk lens: secrets leakage, unpinned versions, app-source drift in an
 * infra-only PR.
 */

'use strict';

const {
  readChangedFiles,
  readFileFromWorktree,
  isDevopsFile,
  isAppSourceFile,
  detectKinds,
} = require('./shared');

function appliesTo(ctx) {
  return detectKinds(ctx.tasksDir).includes('devops');
}

const SECRET_PATTERNS = [
  /(api[_-]?key|token|secret|password|passwd)\s*[:=]\s*['"][^'"\s]{8,}/i,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

function validate(ctx) {
  const changed = readChangedFiles(ctx);
  const devopsFiles = changed.filter(isDevopsFile);
  const errors = [];
  const warnings = [];

  const appDrift = changed.filter(isAppSourceFile);
  if (appDrift.length) {
    errors.push(
      `DevOps PR contains app-source files: ${appDrift
        .map((f) => `\`${f}\``)
        .join(', ')}. Cross-scope — request split.`
    );
  }

  // Secret-leak scan.
  const leakSuspects = [];
  for (const f of devopsFiles) {
    if (!/\.(ya?ml|sh|json|env)$/.test(f)) continue;
    const text = readFileFromWorktree(ctx, f);
    if (!text) continue;
    if (SECRET_PATTERNS.some((re) => re.test(text))) leakSuspects.push(f);
  }
  if (leakSuspects.length) {
    errors.push(
      `Possible secret in: ${leakSuspects
        .map((f) => `\`${f}\``)
        .join(
          ', '
        )}. BLOCK approval — verify via secret manager / GitHub secrets instead of inline.`
    );
  }

  // Unpinned versions in github actions (`uses: x@main`).
  const unpinned = [];
  for (const f of devopsFiles) {
    if (!/^\.github\/.+\.ya?ml$/.test(f)) continue;
    const text = readFileFromWorktree(ctx, f);
    if (!text) continue;
    if (/uses:\s+\S+@(main|master|latest)\b/.test(text)) unpinned.push(f);
  }
  if (unpinned.length) {
    warnings.push(
      `Unpinned action ref (\`@main\`/\`@master\`/\`@latest\`) in: ${unpinned
        .map((f) => `\`${f}\``)
        .join(', ')}. Recommend pinning to a SHA.`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${devopsFiles.length} infra file(s), ${appDrift.length} app-drift, ${leakSuspects.length} secret-suspects`,
  };
}

module.exports = function register(registerKind) {
  registerKind('devops', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
