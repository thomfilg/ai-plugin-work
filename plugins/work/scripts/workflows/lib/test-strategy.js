'use strict';

/**
 * lib/test-strategy.js — GH-590
 *
 * - `KINDS` enum (AC1)
 * - `synthesizeCommand(strategy, envrc)` (AC2)
 * - `validatePeerCitation(strategy, allTasks, citingTask)` (AC11)
 *
 * Pure module; no side effects. `validatePeerCitation` consumes
 * `fileMatchesScope` from the existing `task-scope-globs.js` helper.
 */

const { fileMatchesScope } = require('./task-scope-globs');

const KINDS = Object.freeze({
  UNIT: 'unit',
  INTEGRATION: 'integration',
  E2E: 'e2e',
  VERIFIED_BY: 'verified-by',
  WIRING_CITATION: 'wiring-citation',
  CUSTOM: 'custom',
});

const ENVELOPE_VAR_BY_KIND = Object.freeze({
  [KINDS.UNIT]: 'TEST_UNIT_COMMAND',
  [KINDS.INTEGRATION]: 'TEST_INTEGRATION_COMMAND',
  [KINDS.E2E]: 'TEST_E2E_COMMAND',
});

/**
 * Look up the envelope shell command for a given kind from the parsed
 * `.envrc` vars bag. Returns the verbatim command string or `null`
 * when unset.
 */
function resolveEnvelope(envrc, kind) {
  const varName = ENVELOPE_VAR_BY_KIND[kind];
  if (!varName) return null;
  const vars = (envrc && envrc.vars) || {};
  const value = vars[varName];
  return typeof value === 'string' && value.length > 0 ? { varName, value } : null;
}

/**
 * Synthesise the runnable test command for a Test Strategy block.
 *
 * - `unit` / `integration`: returns the envelope string with
 *   `CHANGED_FILES="<entry>"` prefixed when the corresponding env var is
 *   set, else `pnpm test <entry>` as the pre-envelope fallback.
 * - `verified-by` / `wiring-citation`: returns `null` — no command to run
 *   (the citing task piggybacks on a peer's tests).
 * - `custom`: returns `strategy.command` (preferred) or `strategy.customBody`
 *   (legacy fenced-bash body) verbatim.
 */
const CITATION_KIND_SET = new Set([KINDS.VERIFIED_BY, KINDS.WIRING_CITATION]);
const ENVELOPE_KIND_SET = new Set([KINDS.UNIT, KINDS.INTEGRATION, KINDS.E2E]);

function _synthesizeCustom(strategy) {
  if (typeof strategy.command === 'string' && strategy.command.length > 0) {
    return strategy.command;
  }
  return typeof strategy.customBody === 'string' ? strategy.customBody : null;
}

function _synthesizeEnvelope(strategy, envrc, kind) {
  const entry = strategy.entry;
  if (typeof entry !== 'string' || entry.length === 0) return null;
  const envelope = resolveEnvelope(envrc, kind);
  return envelope ? `CHANGED_FILES="${entry}" eval "$${envelope.varName}"` : `pnpm test ${entry}`;
}

function synthesizeCommand(strategy, envrc) {
  if (!strategy || typeof strategy !== 'object') return null;
  const { kind } = strategy;
  if (CITATION_KIND_SET.has(kind)) return null;
  if (kind === KINDS.CUSTOM) return _synthesizeCustom(strategy);
  if (ENVELOPE_KIND_SET.has(kind)) return _synthesizeEnvelope(strategy, envrc, kind);
  return null;
}

/**
 * Decide whether the peer's `entry` transitively references any path in
 * the citing task's scope. Direct glob match wins; otherwise we strip
 * the `.test.` / `.spec.` infix and `__tests__/` segment to derive the
 * implied source path that the test exercises and match that against
 * scope.
 */
function entryReferencesScope(entry, scopeGlobs) {
  if (typeof entry !== 'string' || !Array.isArray(scopeGlobs)) return false;
  if (fileMatchesScope(entry, scopeGlobs)) return true;

  const candidates = new Set();
  // Strip `.test.` / `.spec.` infix → `foo.test.js` becomes `foo.js`.
  const stripped = entry.replace(/\.(?:test|spec)(\.[a-zA-Z0-9]+)$/, '$1');
  if (stripped !== entry) candidates.add(stripped);

  // Strip `__tests__/` segment → `lib/__tests__/foo.js` becomes `lib/foo.js`.
  const noTestsDir = stripped.replace(/(^|\/)__tests__\//, '$1');
  if (noTestsDir !== stripped) candidates.add(noTestsDir);

  for (const c of candidates) {
    if (fileMatchesScope(c, scopeGlobs)) return true;
  }
  return false;
}

/**
 * True when every path in `citingScope` is matched by at least one glob in
 * `peerScope`. This is the wiring-citation contract: the citing task's
 * surface is fully owned (and therefore tested) by the peer.
 */
function peerScopeCoversCitingScope(peerScope, citingScope) {
  if (!Array.isArray(peerScope) || !Array.isArray(citingScope)) return false;
  if (citingScope.length === 0) return false;
  for (const path of citingScope) {
    if (typeof path !== 'string' || !fileMatchesScope(path, peerScope)) return false;
  }
  return true;
}

function findTaskByHeading(allTasks, heading) {
  if (!Array.isArray(allTasks) || typeof heading !== 'string') return null;
  const numMatch = heading.match(/^Task\s+(\d+)\b/);
  const wantNum = numMatch ? Number(numMatch[1]) : null;
  for (const t of allTasks) {
    if (!t) continue;
    if (t.heading === heading) return t;
    if (wantNum !== null && t.num === wantNum) return t;
  }
  return null;
}

/**
 * Validate a `verified-by` / `wiring-citation` peer pointer:
 *   (a) the peer exists in `allTasks`,
 *   (b) the peer's strategy kind is `unit` or `integration`,
 *   (c) the peer's `entry` path matches at least one glob in the citing
 *       task's `### Files in scope` (via `fileMatchesScope`).
 *
 * Returns `string[]` of error messages — empty array means valid.
 */
function _citingHeading(citingTask) {
  if (!citingTask) return '<unknown task>';
  if (citingTask.heading) return citingTask.heading;
  if (citingTask.num != null) return `Task ${citingTask.num}`;
  return '<unknown task>';
}

function _checkPeerKind(peerStrategy, heading, peer) {
  const peerKind = peerStrategy.kind;
  if (peerKind === KINDS.UNIT || peerKind === KINDS.INTEGRATION || peerKind === KINDS.E2E) {
    return null;
  }
  return `${heading}: Test Strategy peer "${peer}" has kind=${peerKind || '<missing>'}; expected kind=unit, kind=integration, or kind=e2e`;
}

function _checkPeerCoverage(peerStrategy, peerTask, citingTask, heading, peer) {
  const citingScope = (citingTask && citingTask.filesInScope) || [];
  const peerScope = (peerTask && peerTask.filesInScope) || [];
  const peerEntry = peerStrategy.entry;
  const scopeSuperset = peerScopeCoversCitingScope(peerScope, citingScope);
  const entryOverlap =
    typeof peerEntry === 'string' && entryReferencesScope(peerEntry, citingScope);
  if (scopeSuperset || entryOverlap) return null;
  return `${heading}: Test Strategy peer "${peer}" does not cover this task's Files in scope (peer's filesInScope must be a superset, or peer's entry "${peerEntry}" must match)`;
}

function _findPeerOrError(strategy, allTasks, heading, kind) {
  const peer = strategy.peer || strategy.verifiedBy;
  if (typeof peer !== 'string' || peer.length === 0) {
    return { err: `${heading}: Test Strategy kind=${kind} is missing the peer field` };
  }
  const peerTask = findTaskByHeading(allTasks, peer);
  if (!peerTask) {
    return { err: `${heading}: Test Strategy peer "${peer}" not found in tasks.md` };
  }
  return { peer, peerTask };
}

function _firstPeerError(strategy, allTasks, citingTask) {
  if (!strategy || typeof strategy !== 'object') return null;
  const { kind } = strategy;
  if (!CITATION_KIND_SET.has(kind)) return null;

  const heading = _citingHeading(citingTask);
  const found = _findPeerOrError(strategy, allTasks, heading, kind);
  if (found.err) return found.err;

  const { peer, peerTask } = found;
  const peerStrategy = peerTask.testStrategy || peerTask.strategy || {};
  return (
    _checkPeerKind(peerStrategy, heading, peer) ||
    _checkPeerCoverage(peerStrategy, peerTask, citingTask, heading, peer)
  );
}

function validatePeerCitation(strategy, allTasks, citingTask) {
  const err = _firstPeerError(strategy, allTasks, citingTask);
  return err ? [err] : [];
}

module.exports = {
  KINDS,
  synthesizeCommand,
  validatePeerCitation,
  // Exported for the REFACTOR-phase helper test seam.
  resolveEnvelope,
};
