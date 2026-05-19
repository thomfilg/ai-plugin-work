/**
 * Kind: frontend — code-quality check for UI/component work.
 *
 * Focuses on UI-specific anti-patterns:
 *  - `any` / `as any` in component props
 *  - Inline `console.log` in changed component files
 *  - Component files missing companion test files
 */

'use strict';

const {
  readChangedFiles,
  readFileFromWorktree,
  scanTypeScriptViolations,
  hasCompanionTest,
  isFrontendFile,
  detectKinds,
} = require('./shared');

function appliesTo(ctx) {
  const kinds = detectKinds(ctx.tasksDir);
  return kinds.includes('frontend') || kinds.includes('fullstack');
}

function validate(ctx) {
  const changed = readChangedFiles(ctx);
  const frontendFiles = changed.filter(isFrontendFile);
  const errors = [];
  const warnings = [];

  const tsHits = scanTypeScriptViolations(ctx, frontendFiles);
  if (tsHits.length) {
    errors.push(
      `Frontend TypeScript safety violations (${tsHits.length}): ${tsHits
        .slice(0, 3)
        .map((h) => `${h.file}:${h.line} (${h.pattern})`)
        .join('; ')}${tsHits.length > 3 ? '; …' : ''}. Fix or justify each.`
    );
  }

  for (const f of frontendFiles) {
    if (/\.(test|spec|stories)\.[tj]sx?$/.test(f)) continue;
    const text = readFileFromWorktree(ctx, f);
    if (text && /\bconsole\.(log|warn|info)\(/.test(text)) {
      warnings.push(`\`${f}\` contains console.log/warn/info — remove before merge.`);
    }
  }

  const sourceComponents = frontendFiles.filter(
    (f) => /\.(tsx|jsx)$/.test(f) && !/\.(test|spec|stories)\./.test(f)
  );
  const missingTests = sourceComponents.filter((f) => !hasCompanionTest(ctx, f));
  if (missingTests.length) {
    warnings.push(
      `${missingTests.length} component(s) without companion test file: ${missingTests
        .slice(0, 3)
        .map((f) => `\`${f}\``)
        .join(', ')}${missingTests.length > 3 ? ', …' : ''}.`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${frontendFiles.length} frontend file(s), ${tsHits.length} ts-violations, ${missingTests.length} missing-tests`,
  };
}

module.exports = function register(registerKind) {
  registerKind('frontend', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
