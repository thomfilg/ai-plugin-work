/**
 * Kind: wiring — per-task review for "connect-existing-pieces" tasks.
 *
 * Risk lens (per-task): the ECHO-4579 defense at task scope. If brief
 * forbids backend changes, block on backend drift in THIS task's diff.
 * Wiring tasks should be small (<= 8 files); warn beyond that.
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
  // Structural precondition: brief forbids backend AND this task's diff
  // contains backend files. Don't gate on `detectKinds`, because the exact
  // ECHO-4579 case (brief forbids backend + tasks declare frontend) would
  // otherwise silence this check.
  if (detectKinds(ctx.tasksDir).includes('wiring')) return true;
  const brief = readBrief(ctx.tasksDir);
  if (!briefForbidsBackend(brief)) return false;
  return readChangedFiles(ctx).some(isBackendFile);
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
        `Wiring task + brief forbids backend changes, but THIS task's diff touches backend files: ${drift
          .map((f) => `\`${f}\``)
          .join(', ')}. Revert and split into a sibling ticket.`
      );
    }
  }

  if (changed.length > 8) {
    warnings.push(
      `Wiring task diff has ${changed.length} files — wiring tasks should typically be small. Confirm scope.`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${changed.length} files in task diff`,
  };
}

module.exports = function register(registerKind) {
  registerKind('wiring', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
