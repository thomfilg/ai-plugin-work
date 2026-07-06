'use strict';

/**
 * lib/test-strategy-satisfiability.js — W12 generation-time strategy
 * satisfiability (GH-509/echo-5219 class): verify a `### Test Strategy` can
 * actually EXECUTE at implement, while tasks.md is still editable.
 *
 * Split from lib/test-strategy.js purely for the static-quality line budget —
 * it remains ONE implementation: test-strategy.js re-exports
 * `validateStrategySatisfiability`, and every consumer (tasks-phase draft
 * gate, tests) keeps importing lib/test-strategy. Shared enums/helpers are
 * lazy-required from test-strategy at call time (the parent requires this
 * module at load for the re-export, so a top-level back-require would hit an
 * incomplete CJS cycle).
 *
 * Read-only filesystem probe (`fs.existsSync`) — no other side effects.
 */

const fs = require('node:fs');
const path = require('node:path');

const { fileMatchesScope } = require('./task-scope-globs');
// Shared test-file classifier — the SAME function Pass D and kind_assign use.
const { scopeEntryAdmitsOnlyTestFiles } = require('../../../skills/split-in-tasks/lib/task-types');

/** Lazy accessor for the parent module (see cycle note in the header). */
function _ts() {
  return require('./test-strategy');
}

function _hasNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

// kind=e2e accepts the entry shapes the docs teach (`*.e2e.test.*`, directory
// globs like `tests/e2e/**`, and `.e2e.` specs without a `.test.`/`.spec.`
// infix): the gate executes e2e via the TEST_E2E_COMMAND envelope / `pnpm
// test <entry>` fallback, which run those shapes fine. unit/integration keep
// the strict test-file-only rule.
const E2E_ENTRY_SHAPE_RE = /(^|\/)e2e(\/|$)|\.e2e\./i;

/** Error string when the entry shape is unsatisfiable for its kind, or null. */
function _entryShapeError(strategy, entry, heading) {
  const isE2e = strategy.kind === _ts().KINDS.E2E;
  const ok = isE2e
    ? scopeEntryAdmitsOnlyTestFiles(entry) || E2E_ENTRY_SHAPE_RE.test(entry)
    : scopeEntryAdmitsOnlyTestFiles(entry);
  if (ok) return null;
  const accepted = isE2e
    ? '(*.test.* / *.spec.* / *.e2e.* / a path under an e2e/ directory such as tests/e2e/**)'
    : '(*.test.* / *.spec.*)';
  return (
    `${heading}: Test Strategy kind=${strategy.kind} entry "${entry}" is not a test file ` +
    `${accepted} — the RED gate only runs test entries, so this strategy is ` +
    'unsatisfiable at implement'
  );
}

function _envelopeSatisfiabilityErrors(strategy, task, heading, opts) {
  const entry = strategy.entry;
  if (!_hasNonEmptyString(entry)) return []; // shape gate owns the missing-entry error
  const shapeErr = _entryShapeError(strategy, entry, heading);
  if (shapeErr) return [shapeErr];
  // Glob entry: existence not cheaply verifiable — pattern check above still applies.
  if (entry.includes('*')) return [];
  const workDir = opts.workDir;
  if (typeof workDir !== 'string' || !workDir) return []; // cannot probe — fail open
  if (fs.existsSync(path.resolve(workDir, entry))) return [];
  const scope = (task && task.filesInScope) || [];
  if (fileMatchesScope(entry, scope)) return []; // this task creates it
  return [
    `${heading}: Test Strategy entry "${entry}" does not exist and is not covered by this ` +
      "task's `### Files in scope` — the task can neither run nor create it " +
      '(unsatisfiable at implement)',
  ];
}

function _customSatisfiabilityErrors(strategy, heading) {
  const raw = _hasNonEmptyString(strategy.command) ? strategy.command : strategy.customBody;
  if (!_hasNonEmptyString(raw)) return []; // shape gate owns the missing-command error
  const reason = _ts().detectMalformedTestCommand(raw);
  if (!reason) return [];
  return [
    `${heading}: Test Strategy kind=custom command is malformed (${reason}) — it cannot ` +
      'produce a real exit code at implement. Write a runnable shell command.',
  ];
}

/**
 * Validate that a Test Strategy is SATISFIABLE at implement time. Envelope
 * kinds: `entry:` must be test-file shaped (shared glob-aware classifier;
 * kind=e2e additionally accepts the documented e2e shapes) and a literal
 * entry must exist under `opts.workDir` OR match the citing task's
 * `### Files in scope` (the task creates it). Custom: the raw command/body
 * must pass `detectMalformedTestCommand`. Citation kinds: no checks here
 * (`validatePeerCitation` owns them). Returns string[] — empty means valid.
 */
function validateStrategySatisfiability(strategy, task, opts) {
  if (!strategy || typeof strategy !== 'object') return [];
  const ts = _ts();
  const heading = ts._citingHeading(task);
  if (ts.ENVELOPE_KIND_SET.has(strategy.kind)) {
    return _envelopeSatisfiabilityErrors(strategy, task, heading, opts || {});
  }
  if (strategy.kind === ts.KINDS.CUSTOM) return _customSatisfiabilityErrors(strategy, heading);
  return [];
}

module.exports = { validateStrategySatisfiability };
