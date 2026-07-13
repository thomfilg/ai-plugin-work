/**
 * Kind: backend — code-quality check for API / data-layer work.
 *
 * Focuses on backend-specific anti-patterns:
 *  - TypeScript safety violations in route/schema files
 *  - Missing Zod input/output validation in changed routes
 *  - Missing integration test for changed backend files
 */

'use strict';

const {
  readChangedFiles,
  readFileFromWorktree,
  scanTypeScriptViolations,
  isBackendFile,
  detectKinds,
} = require('./shared');

function appliesTo(ctx) {
  const kinds = detectKinds(ctx.tasksDir);
  return kinds.includes('backend') || kinds.includes('fullstack');
}

function looksLikeRoute(p, text) {
  if (!/(^|\/)app\/api\//.test(p)) return false;
  if (!text) return false;
  return /\bexport\s+(default|const|async\s+function|function)\b/.test(text);
}

function validate(ctx) {
  const changed = readChangedFiles(ctx);
  const backendFiles = changed.filter(isBackendFile);
  const errors = [];
  const warnings = [];

  const tsHits = scanTypeScriptViolations(ctx, backendFiles);
  if (tsHits.length) {
    errors.push(
      `Backend TypeScript safety violations (${tsHits.length}): ${tsHits
        .slice(0, 3)
        .map((h) => `${h.file}:${h.line} (${h.pattern})`)
        .join('; ')}${tsHits.length > 3 ? '; …' : ''}. Add proper schemas/types.`
    );
  }

  let routesWithoutZod = 0;
  const routeOffenders = [];
  for (const f of backendFiles) {
    const text = readFileFromWorktree(ctx, f);
    if (!looksLikeRoute(f, text)) continue;
    if (!/\b(z\.|zod|Schema|schema)\b/.test(text)) {
      routesWithoutZod++;
      routeOffenders.push(f);
    }
  }
  if (routesWithoutZod) {
    warnings.push(
      `${routesWithoutZod} route(s) without visible Zod/schema validation: ${routeOffenders
        .slice(0, 3)
        .map((f) => `\`${f}\``)
        .join(
          ', '
        )}${routeOffenders.length > 3 ? ', …' : ''}. Add input validation at the boundary.`
    );
  }

  const integrationFiles = changed.filter(
    (f) => /\.integration\.(test|spec)\./.test(f) || /\/tests?\/integration\//.test(f)
  );
  if (backendFiles.length && !integrationFiles.length) {
    warnings.push(
      'Backend code changed but no integration test file in diff. Bug fixes/new features should ship with at least one integration test.'
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${backendFiles.length} backend file(s), ${tsHits.length} ts-violations, ${routesWithoutZod} route(s) missing schema`,
  };
}

module.exports = function register(registerKind) {
  registerKind('backend', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
