/**
 * Kind: wiring — completion check for "connect-existing-pieces" tickets.
 *
 * The ECHO-4579 defense at completion-time: even if spec passed, the
 * actual diff might still have crossed scope. BLOCK on any backend file in
 * the diff when brief says "no backend changes".
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
  const kinds = detectKinds(ctx.tasksDir);
  if (kinds.includes('wiring')) return true;
  const brief = readBrief(ctx.tasksDir);
  if (briefForbidsBackend(brief) && kinds.length === 0) return true;
  return false;
}

function validate(ctx) {
  const brief = readBrief(ctx.tasksDir);
  const changed = readChangedFiles(ctx);
  const errors = [];
  const warnings = [];

  const drift = changed.filter(isBackendFile);
  if (briefForbidsBackend(brief)) {
    if (drift.length) {
      errors.push(
        `Wiring + brief forbids backend changes, but diff contains backend files: ${drift
          .map((f) => `\`${f}\``)
          .join(', ')}. ECHO-4579 failure mode — BLOCK completion, do NOT proceed.`
      );
    }
  } else if (drift.length) {
    warnings.push(
      `Wiring kind but diff contains backend files: ${drift.map((f) => `\`${f}\``).join(', ')}. Confirm these were intentional.`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${changed.length} changed, ${drift.length} backend-suspect`,
  };
}

module.exports = function register(registerKind) {
  registerKind('wiring', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
