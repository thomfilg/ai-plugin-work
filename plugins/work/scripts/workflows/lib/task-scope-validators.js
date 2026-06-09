/**
 * task-scope-validators.js
 *
 * Validation functions extracted from task-scope.js. Each validator returns
 * an array of human-readable error messages (empty when clean).
 *
 * `validateTaskTestScope` lives in `task-scope-test-validator.js` (large
 * enough to warrant its own file) and is re-exported via task-scope.js.
 *
 * Behavior preserved exactly — refactor only reduces cyclomatic complexity
 * and nesting depth via helper extraction.
 */

'use strict';

const { _isAbsolutePathEntry, fileMatchesScope } = require('./task-scope-globs');

// ---------------------------------------------------------------------------
// validateTask
// ---------------------------------------------------------------------------

function _isCheckpointTask(task) {
  const taskType = typeof task.type === 'string' ? task.type.toLowerCase().trim() : null;
  return taskType === 'checkpoint' || task.isCheckpoint === true;
}

function _checkScopePresence(task, label, errors) {
  const hasInScope = Array.isArray(task.filesInScope) && task.filesInScope.length > 0;
  const hasLegacyScope =
    typeof task.suggestedScope === 'string' && task.suggestedScope.trim().length > 0;
  if (!hasInScope && !hasLegacyScope) {
    errors.push(
      `${label} is missing both \`### Files in scope\` AND \`### Suggested Scope\` (need at least one)`
    );
  }
  if (task.filesOutOfScope !== undefined && !Array.isArray(task.filesOutOfScope)) {
    errors.push(`${label} has malformed \`### Files explicitly out of scope\` section`);
  }
}

function _checkCrossTaskDepsAbsolute(task, label, errors) {
  if (!Array.isArray(task.crossTaskDeps)) return;
  for (const entry of task.crossTaskDeps) {
    if (_isAbsolutePathEntry(entry)) {
      errors.push(
        `${label} \`### Cross-Task Dependencies\` entry "${entry}" is an absolute path. ` +
          'Cross-task dep entries must be repo-relative (e.g. `src/shared/schema.ts`).'
      );
    }
  }
}

function _checkScopeFieldsAbsolute(task, label, errors) {
  for (const field of ['filesInScope', 'filesOutOfScope']) {
    const arr = task[field];
    if (!Array.isArray(arr)) continue;
    const display = field === 'filesInScope' ? 'Files in scope' : 'Files explicitly out of scope';
    for (const entry of arr) {
      if (_isAbsolutePathEntry(entry)) {
        errors.push(
          `${label} \`### ${display}\` entry "${entry}" is an absolute path. Entries must be repo-relative.`
        );
      }
    }
  }
}

/**
 * Validate one task object's scope sections.
 *
 * @param {{ num:number, filesInScope?:string[], filesOutOfScope?:string[] }} task
 * @returns {string[]} validation error messages (empty when valid)
 */
function validateTask(task) {
  if (!task || typeof task !== 'object') return ['task must be an object'];
  const errors = [];
  const label = `Task ${task.num ?? '?'}`;
  if (_isCheckpointTask(task)) return errors;

  _checkScopePresence(task, label, errors);
  _checkCrossTaskDepsAbsolute(task, label, errors);
  _checkScopeFieldsAbsolute(task, label, errors);
  return errors;
}

// ---------------------------------------------------------------------------
// validateCrossTaskDepsOwnership
// ---------------------------------------------------------------------------

function _otherTaskOwns(entry, other, declarant) {
  if (!other || other.num === declarant.num) return false;
  const scope = Array.isArray(other.filesInScope) ? other.filesInScope : [];
  if (scope.includes(entry)) return true;
  return fileMatchesScope(entry, scope);
}

function _isEntryOwnedByOther(entry, declarant, tasks) {
  return tasks.some((other) => _otherTaskOwns(entry, other, declarant));
}

function _isValidatableCrossTaskEntry(entry) {
  if (typeof entry !== 'string' || !entry) return false;
  if (_isAbsolutePathEntry(entry)) return false;
  return true;
}

function _crossTaskDepError(task, entry) {
  const label = `Task ${task.num ?? '?'}`;
  return (
    `${label} declares Cross-Task Dependency \`${entry}\` but no other task lists it in ` +
    '`### Files in scope`. Either add `' +
    entry +
    "` to the producing task's `### Files in scope`, or remove it from this task's " +
    '`### Cross-Task Dependencies`. (Cross-task deps must reference paths another task owns; ' +
    'they are not a free-form scope extension.)'
  );
}

function _validateOneCrossTaskTask(task, tasks) {
  const deps = Array.isArray(task?.crossTaskDeps) ? task.crossTaskDeps : [];
  if (deps.length === 0) return [];
  return deps
    .filter(_isValidatableCrossTaskEntry)
    .filter((entry) => !_isEntryOwnedByOther(entry, task, tasks))
    .map((entry) => _crossTaskDepError(task, entry));
}

function validateCrossTaskDepsOwnership(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  const errors = [];
  for (const task of tasks) {
    if (!task) continue;
    errors.push(..._validateOneCrossTaskTask(task, tasks));
  }
  return errors;
}

// ---------------------------------------------------------------------------
// validateIntraTicketScope
// ---------------------------------------------------------------------------

function _findIntraTicketConflict(entry, owner) {
  const scope = Array.isArray(owner.filesInScope) ? owner.filesInScope : [];
  if (scope.length === 0) return false;
  if (scope.includes(entry)) return true;
  if (fileMatchesScope(entry, scope)) return true;
  // Reverse direction: out-of-scope entry may be a glob covering peer literal.
  return scope.some(
    (scopeItem) => typeof scopeItem === 'string' && fileMatchesScope(scopeItem, [entry])
  );
}

function _pushIntraTicketError(declarant, owner, entry, errors) {
  errors.push(
    `Task ${declarant.num ?? '?'} lists \`${entry}\` under \`### Files explicitly out of scope\`, ` +
      `but Task ${owner.num ?? '?'} owns that path via \`### Files in scope\`. ` +
      'Intra-ticket peer ownership is not a sibling-ticket boundary: `### Files explicitly out of scope` ' +
      'is reserved for paths owned by OTHER tickets. Remove the entry from Task ' +
      `${declarant.num ?? '?'} or restructure ownership. ` +
      'See skills/split-in-tasks/docs/scope-sections.md §Files explicitly out of scope (intra-ticket exclusion rule).'
  );
}

function _isPeerOwner(owner, declarant) {
  return owner && owner.num !== declarant.num;
}

function _validateOneOutOfScopeEntry(declarant, entry, tasks, errors) {
  if (typeof entry !== 'string' || !entry) return;
  const peers = tasks.filter((o) => _isPeerOwner(o, declarant));
  for (const owner of peers) {
    if (!_findIntraTicketConflict(entry, owner)) continue;
    _pushIntraTicketError(declarant, owner, entry, errors);
  }
}

function _validateOneIntraTicketDeclarant(declarant, tasks, errors) {
  const outOfScope = Array.isArray(declarant?.filesOutOfScope) ? declarant.filesOutOfScope : [];
  if (outOfScope.length === 0) return;
  for (const entry of outOfScope) {
    _validateOneOutOfScopeEntry(declarant, entry, tasks, errors);
  }
}

function validateIntraTicketScope(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  const errors = [];
  for (const declarant of tasks) {
    if (!declarant) continue;
    _validateOneIntraTicketDeclarant(declarant, tasks, errors);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// validateUniqueOwnership
// ---------------------------------------------------------------------------

/**
 * Return the conflicting path between two scope entries, or null if no overlap.
 */
function _pairOverlapPath(a, b) {
  if (typeof a !== 'string' || !a || typeof b !== 'string' || !b) return null;
  if (a === b) return a;
  if (fileMatchesScope(b, [a])) return b;
  if (fileMatchesScope(a, [b])) return a;
  return null;
}

function _collectPairConflicts(ti, tj) {
  const seen = new Set();
  const conflicts = [];
  for (const a of ti.filesInScope) {
    for (const b of tj.filesInScope) {
      const p = _pairOverlapPath(a, b);
      if (p === null) continue;
      const key = `${ti.num ?? '?'}|${tj.num ?? '?'}|${p}`;
      if (seen.has(key)) continue;
      seen.add(key);
      conflicts.push(p);
    }
  }
  return conflicts;
}

function _pushUniqueOwnershipError(ti, tj, p, errors) {
  errors.push(
    `Task ${ti.num ?? '?'} and Task ${tj.num ?? '?'} both list \`${p}\` under \`### Files in scope\`. ` +
      'Each path must have exactly one owner per ticket — peer tasks coordinate via ' +
      'disjoint scope sets, not shared ownership. ' +
      `Remove \`${p}\` from one task or restructure ownership. ` +
      'See skills/split-in-tasks/docs/scope-sections.md §Unique-ownership rule.'
  );
}

function _hasScope(t) {
  return t && Array.isArray(t.filesInScope) && t.filesInScope.length > 0;
}

function validateUniqueOwnership(tasks) {
  if (!Array.isArray(tasks) || tasks.length < 2) return [];
  const errors = [];
  for (let i = 0; i < tasks.length; i++) {
    const ti = tasks[i];
    if (!_hasScope(ti)) continue;
    for (let j = i + 1; j < tasks.length; j++) {
      const tj = tasks[j];
      if (!_hasScope(tj)) continue;
      const conflicts = _collectPairConflicts(ti, tj);
      for (const p of conflicts) _pushUniqueOwnershipError(ti, tj, p, errors);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// validateTddCycle
// ---------------------------------------------------------------------------

function _detectPhaseInTitle(title) {
  if (typeof title !== 'string') return null;
  const m = title.match(/^\s*(RED|GREEN|REFACTOR)\s*[:\-—–]/i);
  return m ? m[1].toUpperCase() : null;
}

function _extractReqIds(text) {
  if (typeof text !== 'string') return [];
  const ids = new Set();
  for (const m of text.matchAll(/\bR\d+[a-z]?\b/g)) ids.add(m[0]);
  for (const m of text.matchAll(/spec §[^,\n]+/g)) ids.add(m[0].trim());
  for (const m of text.matchAll(/\bbrief (?:AC-\d+|P[012]\s*#\d+)\b/gi)) ids.add(m[0].trim());
  return Array.from(ids);
}

function _enrichForTddCycle(t) {
  return {
    num: t?.num,
    title: t?.title || '',
    type: typeof t?.type === 'string' ? t.type.toLowerCase() : '',
    phase: _detectPhaseInTitle(t?.title || ''),
    reqs: _extractReqIds(t?.requirementsCovered || ''),
  };
}

function _isTddCycleWedge(cur, next) {
  if (!cur.phase) return false;
  if (cur.type === 'checkpoint') return false;
  if (!next || !next.phase || next.type === 'checkpoint') return false;
  const expected = { RED: 'GREEN', GREEN: 'REFACTOR' };
  if (expected[cur.phase] !== next.phase) return false;
  return cur.reqs.some((r) => next.reqs.includes(r));
}

function validateTddCycle(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  const errors = [];
  const enriched = tasks.map(_enrichForTddCycle);

  for (let i = 0; i < enriched.length; i++) {
    const cur = enriched[i];
    const next = enriched[i + 1];
    if (!_isTddCycleWedge(cur, next)) continue;
    const shared = cur.reqs.filter((r) => next.reqs.includes(r));
    errors.push(
      `Task ${cur.num} (${cur.phase}) and Task ${next.num} (${next.phase}) split TDD phases across separate tasks for shared requirement(s) ${shared.join(', ')}. ` +
        `The implement-gate enforces RED→GREEN→REFACTOR within a single task; this decomposition will wedge (RED test fails, GREEN requires editing files owned by Task ${next.num}). ` +
        `Merge into one task with nested deliverables (e.g. ${cur.num}.1.1 RED, ${cur.num}.1.2 GREEN, ${cur.num}.1.3 REFACTOR). ` +
        `See skills/split-in-tasks/SKILL.md Rule 10 (ECHO-4453 wedge).`
    );
  }
  return errors;
}

module.exports = {
  validateTask,
  validateCrossTaskDepsOwnership,
  validateIntraTicketScope,
  validateUniqueOwnership,
  validateTddCycle,
};
