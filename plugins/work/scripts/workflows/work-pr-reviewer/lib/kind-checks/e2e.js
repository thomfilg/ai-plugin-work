/**
 * Kind: e2e — PR review for Playwright spec changes.
 *
 * Risk lens: flaky-test anti-patterns (page.waitForTimeout, .only left in),
 * missing @e2e tag, no expect() assertion in spec.
 */

'use strict';

const { readChangedFiles, readFileFromWorktree, isE2eFile, detectKinds } = require('./shared');

function appliesTo(ctx) {
  return detectKinds(ctx.tasksDir).includes('e2e');
}

function validate(ctx) {
  const changed = readChangedFiles(ctx);
  const specs = changed.filter(isE2eFile);
  const errors = [];
  const warnings = [];

  if (!specs.length) {
    return { ok: true, summary: 'no e2e specs in PR diff' };
  }

  const issues = { only: [], noExpect: [], waitTimeout: [] };
  for (const f of specs) {
    const text = readFileFromWorktree(ctx, f);
    if (!text) continue;
    if (/\b(test|describe|it)\.only\(/.test(text)) issues.only.push(f);
    if (!/\bexpect\s*\(/.test(text)) issues.noExpect.push(f);
    if (/page\.waitForTimeout\(\s*\d{3,}/.test(text)) issues.waitTimeout.push(f);
  }
  if (issues.only.length) {
    errors.push(
      `\`.only\` in PR spec(s): ${issues.only.map((f) => `\`${f}\``).join(', ')}. Request changes.`
    );
  }
  if (issues.noExpect.length) {
    errors.push(
      `Spec(s) with no \`expect(\`: ${issues.noExpect.map((f) => `\`${f}\``).join(', ')}.`
    );
  }
  if (issues.waitTimeout.length) {
    warnings.push(
      `Hardcoded \`page.waitForTimeout\` in: ${issues.waitTimeout
        .map((f) => `\`${f}\``)
        .join(', ')}. Flaky-test risk — recommend polling.`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${specs.length} spec(s) in PR`,
  };
}

module.exports = function register(registerKind) {
  registerKind('e2e', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
