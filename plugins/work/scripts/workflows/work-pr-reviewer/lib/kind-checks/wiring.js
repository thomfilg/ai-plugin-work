/**
 * Kind: wiring — PR review for "connect-existing-pieces" PRs.
 *
 * Risk lens: cross-scope drift (changes outside the declared wire surface).
 * Blocks if PR touches sibling-owned backend files when brief forbids
 * backend changes.
 */

'use strict';

const {
  readBrief,
  readChangedFiles,
  briefForbidsBackend,
  isBackendFile,
  detectKinds,
} = require('./shared');

function appliesTo(ctx) {
  // Structural precondition: brief forbids backend AND the PR diff
  // contains backend files. Don't gate on `detectKinds` — that would
  // silence wiring on the exact ECHO-4579 case (brief forbids backend +
  // tasks declare frontend).
  if (detectKinds(ctx.tasksDir).includes('wiring')) return true;
  return (
    briefForbidsBackend(readBrief(ctx.tasksDir)) &&
    readChangedFiles(ctx).some(isBackendFile)
  );
}

function validate(ctx) {
  const brief = readBrief(ctx.tasksDir);
  const changed = readChangedFiles(ctx);
  const errors = [];
  const warnings = [];

  if (briefForbidsBackend(brief)) {
    const drift = changed.filter(isBackendFile);
    if (drift.length) {
      errors.push(
        `Wiring PR + brief forbids backend changes, but diff contains backend files: ${drift
          .map((f) => `\`${f}\``)
          .join(', ')}. Request author to revert and split into a sibling ticket.`
      );
    }
  }

  // PR size sanity for wiring: should be small. Warn if >15 files.
  if (changed.length > 15) {
    warnings.push(
      `Wiring PR has ${changed.length} changed files — wiring should typically be small. Ask the author to split or justify.`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${changed.length} files in diff`,
  };
}

module.exports = function register(registerKind) {
  registerKind('wiring', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
