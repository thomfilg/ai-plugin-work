'use strict';

/**
 * tdd-mode.js — single source of truth for WORK_TDD_MODE resolution
 * (GH-750 epic; docs/implement-outcome-verification-plan.md §5.1).
 *
 * `outcome` is the DEFAULT: unset (or empty) resolves to outcome mode, so the
 * task-boundary verifier decides advance and the phase-scoped edit/stop hooks
 * stand aside. `process` (the legacy RED/GREEN choreography) and `shadow`
 * (legacy gates + verifier logging with no authority) are explicit opt-ins.
 *
 * Every mode read goes through here: a bare
 * `process.env.WORK_TDD_MODE === 'outcome'` comparison silently reinstates the
 * old `process` default whenever the variable is unset.
 */

/** The three implement-phase verification modes. */
const MODES = Object.freeze({
  process: 'process',
  shadow: 'shadow',
  outcome: 'outcome',
});

const KNOWN_MODES = Object.freeze(Object.values(MODES));

/** Resolution for an unset, empty, or unrecognized WORK_TDD_MODE. */
const DEFAULT_TDD_MODE = MODES.outcome;

/**
 * Normalize a raw WORK_TDD_MODE value to one of KNOWN_MODES. Unset / empty /
 * unrecognized → DEFAULT_TDD_MODE; config-validate.js is what warns about a
 * malformed value at startup, so resolution itself is total and never throws.
 *
 * @param {unknown} raw
 * @returns {string} one of KNOWN_MODES
 */
function normalizeTddMode(raw) {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return KNOWN_MODES.includes(value) ? value : DEFAULT_TDD_MODE;
}

/**
 * Resolve the active mode from an env-like object.
 * @param {Record<string, string|undefined>} [env] defaults to process.env
 * @returns {string} one of KNOWN_MODES
 */
function resolveTddMode(env = process.env) {
  return normalizeTddMode(env ? env.WORK_TDD_MODE : undefined);
}

/**
 * Resolve the mode the way `resolveTddMode()` does, but fall back to the repo
 * `.env` (via the shared config loader) when the variable is absent from the
 * process environment. Hooks that read the mode BEFORE any sibling require
 * pulls in `config.js` need this — otherwise an `.env`-only opt-out never
 * reaches them. Lazy and fail-open: the loader is required only on the
 * fallback path, and a broken loader resolves to the default.
 *
 * @returns {string} one of KNOWN_MODES
 */
function resolveConfiguredTddMode() {
  if (process.env.WORK_TDD_MODE) return normalizeTddMode(process.env.WORK_TDD_MODE);
  try {
    return normalizeTddMode(require('./get-config')('WORK_TDD_MODE'));
  } catch {
    return DEFAULT_TDD_MODE;
  }
}

/** Outcome mode (default): verifier verdicts decide advance, no phase locks. */
function isOutcomeMode(env = process.env) {
  return resolveTddMode(env) === MODES.outcome;
}

/** Shadow mode: legacy gates keep authority; the verifier only logs. */
function isShadowMode(env = process.env) {
  return resolveTddMode(env) === MODES.shadow;
}

/** Process mode: the legacy RED/GREEN choreography, now an explicit opt-in. */
function isProcessMode(env = process.env) {
  return resolveTddMode(env) === MODES.process;
}

module.exports = {
  MODES,
  KNOWN_MODES,
  DEFAULT_TDD_MODE,
  normalizeTddMode,
  resolveTddMode,
  resolveConfiguredTddMode,
  isOutcomeMode,
  isShadowMode,
  isProcessMode,
};
