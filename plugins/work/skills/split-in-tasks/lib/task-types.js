'use strict';

/**
 * task-types.js — Closed enum for the `### Type` field in tasks.md.
 *
 * Single source of truth for which gate contract a task gets at implement time.
 * The planner (split-in-tasks) writes ONE of these values into each task's
 * `### Type` line; the implementer (task-next.js / tdd-phase-state.js) reads it
 * and applies the matching contract. The implementer must not be able to
 * promote a TDD-required task to a TDD-exempt one — that decision belongs to
 * the planner and is enforced by hooks (protect-task-scope.js + a Type-line
 * edit guard).
 *
 * Adding a new Type: add it to either TDD_REQUIRED_TYPES or TDD_EXEMPT_TYPES
 * (never both), and extend gateContractFor() with its rcdEmptyTrap /
 * redRequiresTestFiles flags. Pass D (lib/lint-type-ac-consistency.js) will
 * pick it up automatically through allTaskTypes().
 */

const TDD_REQUIRED_TYPES = Object.freeze(['tdd-code']);

const TDD_EXEMPT_TYPES = Object.freeze([
  'tests-only',
  'docs',
  'config',
  'ci',
  'mechanical-refactor',
  'file-move',
  'checkpoint',
]);

const TASK_TYPES = Object.freeze([...TDD_REQUIRED_TYPES, ...TDD_EXEMPT_TYPES]);

function normalize(t) {
  if (typeof t !== 'string') return '';
  return t.trim().toLowerCase();
}

function isKnownTaskType(t) {
  return TASK_TYPES.includes(normalize(t));
}

function isTddRequired(t) {
  return TDD_REQUIRED_TYPES.includes(normalize(t));
}

function isTddExempt(t) {
  return TDD_EXEMPT_TYPES.includes(normalize(t));
}

function allTaskTypes() {
  return TASK_TYPES.slice();
}

/**
 * Per-Type gate contract returned to the implementer.
 *
 * Fields:
 *   - kind                 — the canonical Type string
 *   - redRequiresTestFiles — if true, RED phase requires modified *.test.* /
 *                            *.spec.* files in scope (tdd-code only)
 *   - rcdEmptyTrap         — if true, GREEN / REFACTOR refuse exit-0 with no
 *                            stdout/stderr (RC-D defense in tdd-phase-state.js)
 *
 * Unknown types fall back to the strictest contract (tdd-code) so missing
 * planner data fails closed.
 */
function gateContractFor(type /* , _scope */) {
  const t = normalize(type);
  switch (t) {
    case 'tdd-code':
      return { kind: 'tdd-code', redRequiresTestFiles: true, rcdEmptyTrap: true };
    case 'tests-only':
      return { kind: 'tests-only', redRequiresTestFiles: false, rcdEmptyTrap: true };
    case 'docs':
      return { kind: 'docs', redRequiresTestFiles: false, rcdEmptyTrap: false };
    case 'config':
      return { kind: 'config', redRequiresTestFiles: false, rcdEmptyTrap: false };
    case 'ci':
      return { kind: 'ci', redRequiresTestFiles: false, rcdEmptyTrap: false };
    case 'mechanical-refactor':
      return { kind: 'mechanical-refactor', redRequiresTestFiles: false, rcdEmptyTrap: true };
    case 'file-move':
      return { kind: 'file-move', redRequiresTestFiles: false, rcdEmptyTrap: false };
    case 'checkpoint':
      return { kind: 'checkpoint', redRequiresTestFiles: false, rcdEmptyTrap: false };
    default:
      // Unknown / freeform Type → strictest contract. Planner-side Pass D
      // should reject this before reaching the implementer, but failing
      // closed here keeps a defense-in-depth layer.
      return { kind: 'tdd-code', redRequiresTestFiles: true, rcdEmptyTrap: true };
  }
}

module.exports = {
  TASK_TYPES,
  TDD_REQUIRED_TYPES,
  TDD_EXEMPT_TYPES,
  isKnownTaskType,
  isTddRequired,
  isTddExempt,
  allTaskTypes,
  gateContractFor,
};
