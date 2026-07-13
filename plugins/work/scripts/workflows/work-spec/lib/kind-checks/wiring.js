/**
 * Kind: wiring — the ECHO-4579 defense.
 *
 * "Wiring" tickets connect existing pieces. They should NOT introduce
 * backend schema changes nor new sibling-owned component shells. If brief
 * says "no backend changes", any backend file in Files to Create/Modify
 * BLOCKS.
 */

'use strict';

const {
  readSpec,
  readBrief,
  filesInFilesToModify,
  briefForbidsBackend,
  isBackendFile,
  detectKinds,
} = require('./shared');

function appliesTo(ctx) {
  // Wiring is a spec-time INVARIANT, not a per-task work-type. It fires
  // whenever the ECHO-4579 contradiction is structurally possible: the
  // brief forbids backend changes AND the spec's Files to Create/Modify
  // lists at least one backend file. Gating this on `detectKinds` would
  // make the check silent on the exact case it's meant to defend — a
  // brief-forbids-backend ticket whose tasks declare frontend kinds.
  //
  // The explicit `### Type: wiring` opt-in is preserved for tickets that
  // declare wiring as their work-type directly.
  if (detectKinds(ctx.tasksDir).includes('wiring')) return true;
  const brief = readBrief(ctx.tasksDir);
  if (!briefForbidsBackend(brief)) return false;
  return filesInFilesToModify(readSpec(ctx.tasksDir)).some(isBackendFile);
}

function validate(ctx) {
  const spec = readSpec(ctx.tasksDir);
  const brief = readBrief(ctx.tasksDir);
  const files = filesInFilesToModify(spec);
  const errors = [];
  const warnings = [];

  const backendDrift = files.filter(isBackendFile);
  if (briefForbidsBackend(brief)) {
    if (backendDrift.length) {
      errors.push(
        `Wiring kind + brief forbids backend changes, but spec lists backend files: ${backendDrift.map((f) => `\`${f}\``).join(', ')}. This is exactly the ECHO-4579 failure mode — STOP, escalate to the sibling owner, do NOT silently extend the sibling surface.`
      );
    }
  } else if (backendDrift.length) {
    warnings.push(
      `Wiring kind but spec lists backend files: ${backendDrift.map((f) => `\`${f}\``).join(', ')}. Confirm these were intentional and not a sibling-scope escape.`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${files.length} files, ${backendDrift.length} backend-suspect`,
  };
}

module.exports = function register(registerKind) {
  registerKind('wiring', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
