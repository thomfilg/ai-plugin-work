/**
 * Kind: backend — PR review for API / data-layer changes.
 *
 * Risk lens:
 *  - Breaking change to procedure inputs/outputs (rename/remove fields).
 *  - Missing integration test in the PR diff.
 *  - Schema migration without rollback notes.
 *  - Auth/permission check skipped on new route.
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
  const k = detectKinds(ctx.tasksDir);
  return k.includes('backend') || k.includes('fullstack');
}

function validate(ctx) {
  const changed = readChangedFiles(ctx);
  const backendFiles = changed.filter(isBackendFile);
  const errors = [];
  const warnings = [];

  const tsHits = scanTypeScriptViolations(ctx, backendFiles);
  if (tsHits.length) {
    errors.push(
      `Backend TS safety violations (${tsHits.length}): ${tsHits
        .slice(0, 3)
        .map((h) => `${h.file}:${h.line} (${h.pattern})`)
        .join('; ')}${tsHits.length > 3 ? '; …' : ''}.`
    );
  }

  // Missing integration test in this PR.
  const hasIntegrationTest = changed.some(
    (f) => /\.integration\.(test|spec)\./.test(f) || /\/tests?\/integration\//.test(f)
  );
  if (backendFiles.length && !hasIntegrationTest) {
    warnings.push(
      'Backend code changed in this PR with no integration test in the diff. Ask the author for at least one.'
    );
  }

  // Migration touched without ROLLBACK note in commit/PR body.
  const migrations = changed.filter((f) => /\/(migrations|prisma\/migrations)\//.test(f));
  if (migrations.length) {
    warnings.push(
      `${migrations.length} migration file(s) in PR. Confirm the PR description includes a rollback plan.`
    );
  }

  // Permission/auth check heuristic for new routes.
  const newRoutesWithoutAuth = [];
  for (const f of backendFiles) {
    if (!/(^|\/)app\/api\//.test(f)) continue;
    const text = readFileFromWorktree(ctx, f);
    if (!text) continue;
    if (!/(authorize|permission|requireAuth|getServerSession|protectedProcedure)/i.test(text)) {
      newRoutesWithoutAuth.push(f);
    }
  }
  if (newRoutesWithoutAuth.length) {
    warnings.push(
      `Route(s) without visible auth/permission check: ${newRoutesWithoutAuth
        .slice(0, 3)
        .map((f) => `\`${f}\``)
        .join(
          ', '
        )}${newRoutesWithoutAuth.length > 3 ? ', …' : ''}. Confirm intentional public access.`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${backendFiles.length} backend file(s), ${tsHits.length} ts-violations, ${migrations.length} migration(s)`,
  };
}

module.exports = function register(registerKind) {
  registerKind('backend', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
