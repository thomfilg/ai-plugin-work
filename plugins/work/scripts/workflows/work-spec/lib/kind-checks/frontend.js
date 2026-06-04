/**
 * Kind: frontend — UI/component work.
 *
 * Verifies:
 *  - Files to Create/Modify contains at least one component or page file.
 *  - Test Scenarios mention loading + empty + error + success states.
 *  - If the brief said "no backend changes", spec touches NO backend file.
 */

'use strict';

const {
  readSpec,
  readBrief,
  filesInFilesToModify,
  briefForbidsBackend,
  isFrontendFile,
  isBackendFile,
  detectKinds,
} = require('./shared');

function appliesTo(ctx) {
  const kinds = detectKinds(ctx.tasksDir);
  return kinds.includes('frontend') || kinds.includes('fullstack');
}

const STATE_WORDS = ['loading', 'empty', 'error'];

function validate(ctx) {
  const spec = readSpec(ctx.tasksDir);
  const brief = readBrief(ctx.tasksDir);
  const files = filesInFilesToModify(spec);
  const errors = [];
  const warnings = [];

  if (!files.some(isFrontendFile)) {
    warnings.push(
      'frontend kind detected but no component / page / hook file is listed in `## Files to Create/Modify`.'
    );
  }

  const specLower = spec.toLowerCase();
  for (const w of STATE_WORDS) {
    if (!specLower.includes(w)) {
      warnings.push(
        `Test Scenarios do not mention "${w}" state — verify all UI states are covered.`
      );
    }
  }

  if (briefForbidsBackend(brief)) {
    const backendDrift = files.filter(isBackendFile);
    if (backendDrift.length) {
      errors.push(
        `Brief forbids backend changes, but spec lists backend files in \`## Files to Create/Modify\`: ${backendDrift.map((f) => `\`${f}\``).join(', ')}. Remove them or escalate to the sibling owner.`
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${files.length} files listed (${files.filter(isFrontendFile).length} frontend)`,
  };
}

module.exports = function register(registerKind) {
  registerKind('frontend', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
module.exports.STATE_WORDS = STATE_WORDS;
