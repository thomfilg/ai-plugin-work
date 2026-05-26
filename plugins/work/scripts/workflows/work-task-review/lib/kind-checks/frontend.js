/**
 * Kind: frontend — per-task review for UI work.
 *
 * Risk lens (per-task scope): every added .tsx/.jsx file should have a
 * companion test; warn on inline styles / hardcoded colors that hint at
 * style drift; flag accidental backend-schema drift.
 */

'use strict';

const {
  readChangedFiles,
  hasCompanionTest,
  isFrontendFile,
  isBackendFile,
  detectKinds,
  readFileFromWorktree,
} = require('./shared');

function appliesTo(ctx) {
  if (detectKinds(ctx.tasksDir).includes('frontend')) return true;
  return readChangedFiles(ctx).some(isFrontendFile);
}

function validate(ctx) {
  const changed = readChangedFiles(ctx);
  const fe = changed.filter(isFrontendFile);
  const errors = [];
  const warnings = [];

  for (const f of fe) {
    if (!/\.(?:t|j)sx$/.test(f)) continue;
    if (!hasCompanionTest(ctx, f)) {
      warnings.push(`Frontend file \`${f}\` has no companion \`.test\`/\`.spec\` file.`);
    }
    const text = readFileFromWorktree(ctx, f) || '';
    if (/style=\{\{[^}]*color\s*:/i.test(text)) {
      warnings.push(`\`${f}\` uses inline-style color — prefer tokens/theme.`);
    }
  }

  // Cross-kind drift: frontend task should not touch backend schemas.
  const beDrift = changed.filter(isBackendFile);
  if (fe.length && beDrift.length) {
    warnings.push(
      `Frontend task also touches backend file(s): ${beDrift
        .slice(0, 3)
        .map((f) => `\`${f}\``)
        .join(', ')}. Confirm this is intended.`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${fe.length} frontend file(s) reviewed`,
  };
}

module.exports = function register(registerKind) {
  registerKind('frontend', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
