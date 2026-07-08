/**
 * Kind: e2e — code-quality check for Playwright e2e specs.
 *
 * Flags:
 *  - Hardcoded `page.waitForTimeout(NNNN)` (test flakiness anti-pattern).
 *  - Specs without any `expect(...)` assertion.
 *  - `.only` left in committed specs.
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
    warnings.push('E2E kind detected but no spec file in diff.');
    return { ok: true, errors, warnings, summary: 'no e2e specs in diff' };
  }

  const waitTimeoutOffenders = [];
  const noAssertion = [];
  const focusOnly = [];

  for (const f of specs) {
    const text = readFileFromWorktree(ctx, f);
    if (!text) continue;
    if (/page\.waitForTimeout\(\s*\d{3,}/.test(text)) waitTimeoutOffenders.push(f);
    if (!/\bexpect\s*\(/.test(text)) noAssertion.push(f);
    if (/\b(test|describe|it)\.only\(/.test(text)) focusOnly.push(f);
  }

  if (focusOnly.length) {
    errors.push(
      `\`.only\` left in committed spec(s): ${focusOnly.map((f) => `\`${f}\``).join(', ')}. Remove before merge.`
    );
  }
  if (noAssertion.length) {
    errors.push(
      `Spec(s) without any \`expect(\` assertion: ${noAssertion.map((f) => `\`${f}\``).join(', ')}.`
    );
  }
  if (waitTimeoutOffenders.length) {
    warnings.push(
      `Hardcoded \`page.waitForTimeout\` in: ${waitTimeoutOffenders
        .map((f) => `\`${f}\``)
        .join(', ')}. Prefer \`expect(...).toBeVisible()\` polling.`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${specs.length} spec(s), ${focusOnly.length} .only, ${noAssertion.length} no-expect, ${waitTimeoutOffenders.length} waitForTimeout`,
  };
}

module.exports = function register(registerKind) {
  registerKind('e2e', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
