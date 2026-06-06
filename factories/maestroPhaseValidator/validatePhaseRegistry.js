'use strict';

/**
 * validatePhaseRegistry — completeness checks for the maestro phase
 * registry tuple `{ BASE, PHASES, detectors, stepIds }`. Returns
 * `{ valid: bool, errors: string[], warnings: string[] }`.
 *
 * Analogous to `factories/registryValidator` but scoped to
 * `plugins/maestro/scripts/lib/maestro-conduct/phase-registry.js`. The
 * goal is the same: a typo in `PHASES['implement'].detectors = ['commiStall']`
 * (missing 't') would silently never fire — no runtime error, just a
 * detector that never runs. This validator catches that at test time.
 *
 * Checks:
 *   R1. Every detector name in `BASE.detectors` is a key in `detectors`.
 *   R2. Every detector name in any `PHASES[*].detectors` is a key in `detectors`.
 *   R3. No duplicate detector names within a single detectors array.
 *   R4. (Optional) When `stepIds` is provided — i.e. the /work step
 *       registry's `STEPS` values — every `PHASES` key resolves to a known
 *       step id. Maestro tracks /work phases by step id, so a typo here is
 *       silent (the phase falls through to UNKNOWN and the budget defaults).
 *   R5. Each detector's `module.exports.name` matches the registry key
 *       it's registered under (catches "registered as `commitStall` but
 *       export name says `commit-stall`" drift).
 *
 * Warnings (non-fatal):
 *   W1. Detectors present in `detectors` but never referenced by any phase
 *       (orphan detector — probably should be added to BASE or a phase).
 */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function detectorsForPhase(BASE, phaseOverride) {
  if (phaseOverride && Array.isArray(phaseOverride.detectors)) return phaseOverride.detectors;
  return BASE.detectors || [];
}

function checkBaseDetectors(BASE, detectors, errors) {
  if (!Array.isArray(BASE.detectors)) {
    errors.push('R1: BASE.detectors must be an array');
    return;
  }
  for (const name of BASE.detectors) {
    if (!(name in detectors))
      errors.push(`R1: BASE.detectors references unknown detector "${name}"`);
  }
}

function checkPhaseDetectors(PHASES, detectors, errors) {
  for (const [phase, override] of Object.entries(PHASES)) {
    if (!override || !Array.isArray(override.detectors)) continue;
    for (const name of override.detectors) {
      if (!(name in detectors)) {
        errors.push(`R2: PHASES["${phase}"].detectors references unknown detector "${name}"`);
      }
    }
  }
}

function checkNoDuplicates(BASE, PHASES, errors) {
  const allLists = [['BASE', BASE.detectors || []]];
  for (const [phase, override] of Object.entries(PHASES)) {
    if (override && Array.isArray(override.detectors)) allLists.push([phase, override.detectors]);
  }
  for (const [label, list] of allLists) {
    const seen = new Set();
    for (const name of list) {
      if (seen.has(name)) errors.push(`R3: duplicate detector "${name}" in ${label}.detectors`);
      seen.add(name);
    }
  }
}

function checkPhaseKeysAgainstStepIds(PHASES, stepIds, errors) {
  if (!stepIds) return;
  const validSteps = new Set(stepIds);
  for (const phase of Object.keys(PHASES)) {
    if (!validSteps.has(phase)) {
      errors.push(`R4: PHASES key "${phase}" is not a known /work step id`);
    }
  }
}

function checkDetectorNamesMatchKeys(detectors, errors) {
  for (const [key, mod] of Object.entries(detectors)) {
    if (!mod || typeof mod !== 'object') {
      errors.push(`R5: detectors["${key}"] is not a module object`);
      continue;
    }
    if (typeof mod.detect !== 'function') {
      errors.push(`R5: detectors["${key}"] has no detect() function`);
    }
    if (mod.name && mod.name !== key) {
      errors.push(
        `R5: detectors["${key}"].name === "${mod.name}" — key and exported name disagree`
      );
    }
  }
}

function collectReferencedDetectors(BASE, PHASES) {
  const referenced = new Set(BASE.detectors || []);
  for (const override of Object.values(PHASES)) {
    if (override && Array.isArray(override.detectors)) {
      for (const name of override.detectors) referenced.add(name);
    }
  }
  return referenced;
}

function collectOrphanWarnings(BASE, PHASES, detectors, warnings) {
  const referenced = collectReferencedDetectors(BASE, PHASES);
  for (const key of Object.keys(detectors)) {
    if (!referenced.has(key))
      warnings.push(`W1: detector "${key}" is registered but never referenced by any phase`);
  }
}

function validatePhaseRegistry(input) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(input)) {
    return { valid: false, errors: ['registry object required'], warnings };
  }
  const { BASE, PHASES, detectors, stepIds } = input;
  if (!isPlainObject(BASE)) errors.push('R1: BASE must be an object');
  if (!isPlainObject(PHASES)) errors.push('R2: PHASES must be an object');
  if (!isPlainObject(detectors)) errors.push('R1: detectors must be an object');
  if (errors.length) return { valid: false, errors, warnings };

  checkBaseDetectors(BASE, detectors, errors);
  checkPhaseDetectors(PHASES, detectors, errors);
  checkNoDuplicates(BASE, PHASES, errors);
  checkPhaseKeysAgainstStepIds(PHASES, stepIds, errors);
  checkDetectorNamesMatchKeys(detectors, errors);
  collectOrphanWarnings(BASE, PHASES, detectors, warnings);

  return { valid: errors.length === 0, errors, warnings };
}

module.exports = { validatePhaseRegistry, detectorsForPhase };
