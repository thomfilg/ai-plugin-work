'use strict';

/**
 * version-skew.js — plugin version skew detection for /work tickets (GH-768).
 *
 * Every fresh `.work-state.json` records the plugin version that created it
 * (`pluginVersionAnchor` + `pluginVersionAnchorAt`). At workflow start the
 * anchor is compared against the executing plugin version and one of three
 * outcomes applies:
 *
 *   - `warn`   — both versions are valid and different: return a loud WARN
 *                banner (never a block) and append ONE audit row per distinct
 *                executing version (de-duplicated via `ws.versionSkewWarnedFor`).
 *   - `adopt`  — the anchor is missing/invalid but the executing version is
 *                valid: stamp the anchor silently (graceful degradation for
 *                pre-feature tickets) and persist it.
 *   - `silent` — versions match, or the executing version is unreadable:
 *                do nothing (no banner, no audit row, no state write).
 *
 * NEVER-THROW CONVENTION (mirrors `maybeUpdateBanner` in update-check.js):
 * any failure reading either version, or any injected dependency throwing,
 * falls back to "no warning" — this module must never disrupt the host
 * command.
 *
 * The anchor fields are lazily-created OPTIONAL fields on the durable
 * per-ticket `.work-state.json` (the `gateFingerprints` back-compat pattern):
 * pre-existing state files load unchanged; there is no migration or backfill.
 *
 * Reuse: `readInstalledVersion()` / `isValidVersion()` from update-check.js
 * are the ONLY version-read/validation seams — no new heuristics.
 */

const { isValidVersion, readInstalledVersion } = require('./update-check');

/**
 * Pure decision function for the three-outcome skew contract.
 *
 * @param {string|null|undefined} anchorVersion version recorded in state
 * @param {string|null|undefined} executingVersion currently installed version
 * @returns {{ outcome: 'warn' | 'adopt' | 'silent' }}
 */
function evaluateVersionSkew(anchorVersion, executingVersion) {
  if (!isValidVersion(executingVersion)) return { outcome: 'silent' };
  if (!isValidVersion(anchorVersion)) return { outcome: 'adopt' };
  return anchorVersion === executingVersion ? { outcome: 'silent' } : { outcome: 'warn' };
}

/**
 * Resolve the executing plugin version from an options/deps object. When the
 * caller injected `installedVersion` (tests, checkVersionSkew fan-out), honor
 * it verbatim — even null — otherwise fall back to the real plugin.json read.
 *
 * @param {object} source options/deps object that may carry `installedVersion`
 * @returns {string|null}
 */
function resolveInstalledVersion(source) {
  if (source && 'installedVersion' in source) return source.installedVersion;
  return readInstalledVersion();
}

/**
 * Lazily stamp the version anchor on a work-state object. Idempotent and
 * purely additive: a no-op when a VALID anchor is already present (a valid
 * anchor and its timestamp are never overwritten) or when the executing
 * version is unreadable/invalid. A corrupt (non-semver) anchor is repaired —
 * otherwise the `adopt` outcome would re-save an unchanged state on every
 * workflow start and the garbage anchor would persist for the ticket's
 * lifetime. Never throws.
 *
 * @param {object} ws mutable work-state object
 * @param {{ installedVersion?: string|null }} [opts] injectable version source
 * @returns {void}
 */
function stampVersionAnchor(ws, opts = {}) {
  try {
    if (!ws || typeof ws !== 'object') return;
    if (isValidVersion(ws.pluginVersionAnchor)) return;
    const version = resolveInstalledVersion(opts);
    if (!isValidVersion(version)) return;
    ws.pluginVersionAnchor = version;
    ws.pluginVersionAnchorAt = new Date().toISOString();
  } catch {
    /* never-throw: fall back to no stamp */
  }
}

/**
 * Build the loud WARN banner naming the executing version, the recorded
 * version, and the state file that recorded the anchor.
 *
 * @param {string} executingVersion
 * @param {string} recordedVersion
 * @param {string} statePath
 * @returns {string}
 */
function buildSkewBanner(executingVersion, recordedVersion, statePath) {
  return [
    `WARN: plugin version skew — this workflow is executing plugin version ${executingVersion},`,
    `but ${statePath} recorded version ${recordedVersion} when the ticket was created.`,
    'The workflow continues (warn-only, never a block); behavior may differ from the recorded run.',
  ].join('\n');
}

/**
 * Append the skew audit row and persist the per-executing-version de-dup
 * marker. Each side-effect is individually guarded so a corrupt/throwing
 * sink never disrupts the workflow.
 *
 * @param {object} deps see checkVersionSkew
 * @param {string} executingVersion
 */
function recordSkewOnce(deps, executingVersion) {
  const { ws, safeName, statePath, currentStep, appendAction, saveWorkState } = deps;
  if (ws.versionSkewWarnedFor === executingVersion) return;
  try {
    appendAction(safeName, {
      // The persisted work-state has no `step` string field (only the
      // `currentStep` index + `stepStatus` map), so the caller resolves the
      // step name via getCurrentStep() and injects it as `currentStep`.
      step: currentStep,
      what: 'plugin version skew detected',
      meta: {
        executingVersion,
        recordedVersion: ws.pluginVersionAnchor,
        stateFile: statePath,
      },
    });
  } catch {
    /* audit sink failure is non-fatal */
  }
  ws.versionSkewWarnedFor = executingVersion;
  try {
    saveWorkState(safeName, ws);
  } catch {
    /* state-save failure is non-fatal */
  }
}

/**
 * Workflow-start orchestrator: evaluate skew and apply the outcome.
 *
 * Returns data only — a WARN banner string on skew, `null` otherwise. No
 * `process.exit`, no blocked instruction, no transition gate. The banner
 * repeats on every start while skew persists (the anchor is never
 * re-baselined on warn); the audit row is appended once per distinct
 * executing version.
 *
 * @param {{
 *   ws: object,
 *   safeName: string,
 *   statePath: string,
 *   currentStep?: string,
 *   appendAction: (safeName: string, row: object) => void,
 *   saveWorkState: (safeName: string, ws: object) => void,
 *   installedVersion?: string|null,
 * }} deps injected seams (no real FS in tests)
 * @returns {string|null} WARN banner on skew, null otherwise
 */
function checkVersionSkew(deps) {
  try {
    const { ws, safeName, statePath, saveWorkState } = deps || {};
    if (!ws || typeof ws !== 'object') return null;
    const executingVersion = resolveInstalledVersion(deps);
    const { outcome } = evaluateVersionSkew(ws.pluginVersionAnchor, executingVersion);
    if (outcome === 'silent') return null;
    if (outcome === 'adopt') {
      stampVersionAnchor(ws, { installedVersion: executingVersion });
      try {
        saveWorkState(safeName, ws);
      } catch {
        /* state-save failure is non-fatal */
      }
      return null;
    }
    const banner = buildSkewBanner(executingVersion, ws.pluginVersionAnchor, statePath);
    recordSkewOnce(deps, executingVersion);
    return banner;
  } catch {
    /* never-throw: fall back to no warning */
    return null;
  }
}

module.exports = {
  evaluateVersionSkew,
  stampVersionAnchor,
  checkVersionSkew,
};
