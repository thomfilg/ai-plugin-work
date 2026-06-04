/**
 * Kind: e2e — per-task review for Playwright/e2e changes.
 *
 * Risk lens: `.only` markers (block; will skip every other test);
 * `waitForTimeout` hardcoded waits (flaky); missing `expect(` (no
 * assertions = false pass).
 */

'use strict';

const { readChangedFiles, isE2eFile, detectKinds, readFileFromWorktree } = require('./shared');

function appliesTo(ctx) {
  if (detectKinds(ctx.tasksDir).includes('e2e')) return true;
  return readChangedFiles(ctx).some(isE2eFile);
}

function validate(ctx) {
  const changed = readChangedFiles(ctx);
  const e2e = changed.filter(isE2eFile);
  const errors = [];
  const warnings = [];

  for (const f of e2e) {
    const text = readFileFromWorktree(ctx, f) || '';
    if (/\b(?:test|describe|it)\.only\s*\(/.test(text)) {
      errors.push(`\`${f}\` contains \`.only\` — will silently skip other tests.`);
    }
    if (/waitForTimeout\s*\(/.test(text)) {
      warnings.push(`\`${f}\` uses \`waitForTimeout\` — prefer \`waitFor\` predicate.`);
    }
    if (!/\bexpect\s*\(/.test(text)) {
      warnings.push(`\`${f}\` has no \`expect(\` — likely missing assertions.`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${e2e.length} e2e file(s) reviewed`,
  };
}

module.exports = function register(registerKind) {
  registerKind('e2e', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
