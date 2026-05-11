/**
 * tdd-phase-registry.js
 *
 * Central registry for TDD phase definitions, transitions, and hook rules.
 * Phases cycle: RED -> GREEN -> REFACTOR -> RED ...
 *
 * Usage:
 *   const { TDD_PHASES, tddCanTransition, PHASE_HOOKS } = require('./tdd-phase-registry');
 */

// ─── Phase IDs ──────────────────────────────────────────────────────────────
const TDD_PHASES = Object.freeze({
  red: 'red',
  green: 'green',
  refactor: 'refactor',
});

// ─── Canonical phase ordering ───────────────────────────────────────────────
const TDD_PHASE_ORDER = Object.freeze([TDD_PHASES.red, TDD_PHASES.green, TDD_PHASES.refactor]);

// ─── Phase Transition Graph (cyclic) ────────────────────────────────────────
const TDD_PHASE_TRANSITIONS = Object.freeze({
  [TDD_PHASES.red]: [TDD_PHASES.green],
  [TDD_PHASES.green]: [TDD_PHASES.refactor],
  [TDD_PHASES.refactor]: [TDD_PHASES.red],
});

/**
 * @param {string} current - Current phase
 * @param {string} next - Target phase
 * @returns {boolean}
 */
function tddCanTransition(current, next) {
  const valid = TDD_PHASE_TRANSITIONS[current] || [];
  return valid.includes(next);
}

// ─── Test File Patterns ─────────────────────────────────────────────────────
const TEST_FILE_PATTERNS = Object.freeze([/\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/]);

const TEST_HELPER_PATTERNS = Object.freeze([
  /(^|\/)__mocks__\//,
  /(^|\/)__fixtures__\//,
  /(^|\/)test-utils\//,
  /test-utils\.[jt]sx?$/,
  /(^|\/)test-helper\//,
  /test-helper\.[jt]sx?$/,
  /\.mock\.[jt]sx?$/,
  /\.fixture\.[jt]sx?$/,
]);

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isTestFile(filePath) {
  return TEST_FILE_PATTERNS.some((p) => p.test(filePath));
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isTestHelper(filePath) {
  if (isTestFile(filePath)) return false;
  return TEST_HELPER_PATTERNS.some((p) => p.test(filePath));
}

// ─── Phase Hook Rules ───────────────────────────────────────────────────────
const PHASE_HOOKS = Object.freeze({
  [TDD_PHASES.red]: Object.freeze({
    shouldBlock(filePath) {
      return !isTestFile(filePath);
    },
    blockMessage:
      'TDD RED phase: only .test or .spec files can be modified. Write failing tests first.',
  }),
  [TDD_PHASES.green]: Object.freeze({
    shouldBlock(filePath) {
      return isTestFile(filePath) && !isTestHelper(filePath);
    },
    blockMessage:
      'TDD GREEN phase: test files cannot be modified. Make the tests pass by changing production code.',
  }),
  [TDD_PHASES.refactor]: Object.freeze({
    shouldBlock() {
      return false;
    },
    blockMessage: '',
  }),
});

// ─── Phase Evidence Definitions ─────────────────────────────────────────────
const PHASE_EVIDENCE = Object.freeze({
  [TDD_PHASES.red]: Object.freeze({
    requiresChangedTestFiles: true,
    requiresTestFailure: true,
  }),
  [TDD_PHASES.green]: Object.freeze({
    requiresTestSuccess: true,
  }),
  [TDD_PHASES.refactor]: Object.freeze({
    requiresTestSuccess: true,
  }),
});

module.exports = {
  TDD_PHASES,
  TDD_PHASE_ORDER,
  TDD_PHASE_TRANSITIONS,
  tddCanTransition,
  TEST_FILE_PATTERNS,
  TEST_HELPER_PATTERNS,
  isTestFile,
  isTestHelper,
  PHASE_HOOKS,
  PHASE_EVIDENCE,
};
