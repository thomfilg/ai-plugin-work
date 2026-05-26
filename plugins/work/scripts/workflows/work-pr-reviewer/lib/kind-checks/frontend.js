/**
 * Kind: frontend — PR review for UI changes.
 *
 * Risk lens (different from code-checker):
 *  - Breaking change risk: prop signature changes on exported components.
 *  - Style drift: new `@apply` or inline styles where the codebase uses tokens.
 *  - Missing companion test in the PR diff (PR adds component but no test).
 */

'use strict';

const {
  readChangedFiles,
  readFileFromWorktree,
  scanTypeScriptViolations,
  isFrontendFile,
  detectKinds,
} = require('./shared');

function appliesTo(ctx) {
  const k = detectKinds(ctx.tasksDir);
  return k.includes('frontend') || k.includes('fullstack');
}

function validate(ctx) {
  const changed = readChangedFiles(ctx);
  const frontendFiles = changed.filter(isFrontendFile);
  const errors = [];
  const warnings = [];

  const tsHits = scanTypeScriptViolations(ctx, frontendFiles);
  if (tsHits.length) {
    errors.push(
      `PR frontend changes contain TS safety violations (${tsHits.length}): ${tsHits
        .slice(0, 3)
        .map((h) => `${h.file}:${h.line} (${h.pattern})`)
        .join('; ')}${tsHits.length > 3 ? '; …' : ''}. Request changes before approving.`
    );
  }

  // Heuristic: any new exported component without companion test in the SAME PR.
  const sourceComponents = frontendFiles.filter(
    (f) => /\.(tsx|jsx)$/.test(f) && !/\.(test|spec|stories)\./.test(f)
  );
  const testFiles = new Set(changed.filter((f) => /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(f)));
  const orphans = sourceComponents.filter((f) => {
    const base = f.replace(/\.(tsx|jsx)$/, '');
    return ![`${base}.test.tsx`, `${base}.test.ts`, `${base}.spec.tsx`, `${base}.spec.ts`].some(
      (t) => testFiles.has(t)
    );
  });
  if (orphans.length) {
    warnings.push(
      `${orphans.length} component(s) changed without a companion test in this PR: ${orphans
        .slice(0, 3)
        .map((f) => `\`${f}\``)
        .join(', ')}${orphans.length > 3 ? ', …' : ''}. Ask the author for coverage.`
    );
  }

  // Style drift heuristic: `style={{...}}` or `!important` in changed JSX.
  const styleDrift = [];
  for (const f of frontendFiles) {
    if (!/\.(tsx|jsx)$/.test(f)) continue;
    const text = readFileFromWorktree(ctx, f);
    if (!text) continue;
    if (/style=\{\{|!important/.test(text)) styleDrift.push(f);
  }
  if (styleDrift.length) {
    warnings.push(
      `Inline \`style={{…}}\` or \`!important\` found in: ${styleDrift
        .slice(0, 3)
        .map((f) => `\`${f}\``)
        .join(', ')}${styleDrift.length > 3 ? ', …' : ''}. Prefer design tokens / utility classes.`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${frontendFiles.length} frontend file(s), ${tsHits.length} ts-violations, ${orphans.length} test-orphan(s)`,
  };
}

module.exports = function register(registerKind) {
  registerKind('frontend', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
