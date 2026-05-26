/**
 * Kind: backend — per-task review for API / service work.
 *
 * Risk lens (per-task): every changed router/service file should have a
 * companion `.integration.test` or `.test` file in the diff; surface
 * `any`/`@ts-ignore` introductions; flag schema-touching changes without
 * a matching migration.
 */

'use strict';

const path = require('node:path');

const {
  readChangedFiles,
  hasCompanionTest,
  isBackendFile,
  detectKinds,
  readFileFromWorktree,
} = require('./shared');

function appliesTo(ctx) {
  if (detectKinds(ctx.tasksDir).includes('backend')) return true;
  return readChangedFiles(ctx).some(isBackendFile);
}

function isSchemaFile(f) {
  return /(?:schemas?|prisma|migrations?)\b/i.test(f);
}

function isMigrationFile(f) {
  return /(?:migrations?|prisma\/migrations)/i.test(f);
}

function validate(ctx) {
  const changed = readChangedFiles(ctx);
  const be = changed.filter(isBackendFile);
  const errors = [];
  const warnings = [];

  let testCovered = 0;
  for (const f of be) {
    if (!/\.(?:[mc]?ts)$/.test(f)) continue;
    if (/\.(?:test|spec|integration\.test)\./.test(f)) continue;
    if (hasCompanionTest(ctx, f)) {
      testCovered++;
    } else {
      warnings.push(`Backend file \`${f}\` has no companion test in the diff.`);
    }
    const text = readFileFromWorktree(ctx, f) || '';
    if (/\bany\b|@ts-ignore|@ts-expect-error/.test(text)) {
      warnings.push(`\`${f}\` introduces \`any\` / \`@ts-ignore\` / \`@ts-expect-error\`.`);
    }
  }

  const schemaTouched = be.filter(isSchemaFile);
  const migrations = changed.filter(isMigrationFile);
  if (schemaTouched.length && !migrations.length) {
    warnings.push(
      `Schema files changed (${schemaTouched
        .slice(0, 3)
        .map((f) => `\`${path.basename(f)}\``)
        .join(', ')}) without a matching migration file.`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${be.length} backend file(s) reviewed, ${testCovered} test-covered`,
  };
}

module.exports = function register(registerKind) {
  registerKind('backend', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
module.exports.isSchemaFile = isSchemaFile;
module.exports.isMigrationFile = isMigrationFile;
