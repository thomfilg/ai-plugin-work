/**
 * Kind: backend — completion check for API / data-layer work.
 *
 * Completion criteria:
 *  - Diff contains at least one backend file (route, schema, prisma, server).
 *  - At least one integration test file changed in the diff.
 *  - tasks.md `Requirement Coverage` table has no row with empty/PENDING status.
 */

'use strict';

const {
  readChangedFiles,
  readRequirementCoverage,
  isBackendFile,
  detectKinds,
} = require('./shared');

function appliesTo(ctx) {
  const kinds = detectKinds(ctx.tasksDir);
  return kinds.includes('backend') || kinds.includes('fullstack');
}

function isIntegrationTest(p) {
  return /\.integration\.(test|spec)\.[tj]sx?$/.test(p) || /\/tests?\/integration\//.test(p);
}

function validate(ctx) {
  const changed = readChangedFiles(ctx);
  const errors = [];
  const warnings = [];

  const backendFiles = changed.filter(isBackendFile);
  if (!backendFiles.length) {
    warnings.push(
      'Backend kind detected but the diff contains no backend file (route, schema, prisma). Verify the API change shipped.'
    );
  }

  const integrationFiles = changed.filter(isIntegrationTest);
  if (!integrationFiles.length) {
    warnings.push(
      'No integration test file changed — backend changes should ship with at least one integration test.'
    );
  }

  const coverage = readRequirementCoverage(ctx.tasksDir);
  const incomplete = coverage.filter(
    (r) => !/delivered|done|complete|ok/i.test(r.status) && r.status.trim().length > 0
  );
  if (incomplete.length) {
    errors.push(
      `Requirement Coverage has ${incomplete.length} incomplete row(s): ${incomplete
        .slice(0, 3)
        .map((r) => `\`${r.id}\``)
        .join(', ')}${incomplete.length > 3 ? ', …' : ''}. All must be DELIVERED before completion.`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${backendFiles.length} backend file(s), ${integrationFiles.length} integration test(s), ${coverage.length} coverage rows`,
  };
}

module.exports = function register(registerKind) {
  registerKind('backend', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
module.exports.isIntegrationTest = isIntegrationTest;
