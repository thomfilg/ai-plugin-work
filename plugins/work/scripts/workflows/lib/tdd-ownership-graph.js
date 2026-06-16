'use strict';

/**
 * TDD ownership graph (GH-590, AC10/AC15).
 *
 * Given the parsed tasks from a `tasks.md`, this module computes which task(s)
 * transitively exercise each path declared in any `### Files in scope` block,
 * and surfaces paths that an owner declares but no task actually covers.
 *
 * "Transitively exercise" = some task's Test Strategy `entry` references a
 * path that, under `fileMatchesScope`, matches the candidate path. Tasks
 * declaring `kind: verified-by` or `kind: wiring-citation` cover their own
 * scope by citation (peer is validated separately by `validatePeerCitation`).
 *
 * Docs-only policy: a task whose `Files in scope` is 100% `*.md` is NOT
 * auto-covered — it must declare `kind: wiring-citation` or
 * `kind: verified-by`. Otherwise its docs paths are reported as orphans.
 *
 * Public API:
 *   - buildCoverageGraph(tasks): Map<path, Set<taskNum>>
 *   - findOrphanedPaths(tasks, graph): { path, owner, remediation }[]
 */

const { fileMatchesScope } = require('./task-scope-globs');

const MD_EXT_RE = /\.md$/i;
const CITATION_KINDS = new Set(['verified-by', 'wiring-citation']);
const ENTRY_KINDS = new Set(['unit', 'integration']);

/**
 * Predicate: every file-in-scope path is a Markdown doc.
 *
 * @param {string[]} paths
 * @returns {boolean}
 */
function isDocsOnlyScope(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return false;
  return paths.every((p) => typeof p === 'string' && MD_EXT_RE.test(p));
}

/**
 * Build a coverage graph keyed by every path declared in any task's
 * `### Files in scope`. The value is the set of task numbers that
 * transitively cover that path.
 *
 * Coverage rules:
 *   - A task with `kind: unit`/`integration` covers any of its own
 *     scope paths whose glob matches the strategy's `entry`.
 *   - A task with citation kinds (`verified-by`/`wiring-citation`)
 *     covers its own scope paths by citation (peer validation is
 *     handled elsewhere).
 *   - A task may also transitively cover a peer task's path when its
 *     `entry` matches that peer's scope.
 *
 * @param {Array<object>} tasks
 * @returns {Map<string, Set<number>>}
 */
function _scopeOf(task) {
  return Array.isArray(task && task.filesInScope) ? task.filesInScope : [];
}

function _seedGraph(tasks, graph) {
  for (const t of tasks) {
    for (const p of _scopeOf(t)) {
      if (typeof p === 'string' && p && !graph.has(p)) graph.set(p, new Set());
    }
  }
}

function _entryCoversPath(entry, p) {
  return entry === p || fileMatchesScope(entry, [p]) || fileMatchesScope(p, [entry]);
}

function _applyEntryCoverage(graph, entry, taskNum, ownScope) {
  for (const [path] of graph) {
    if (_entryCoversPath(entry, path)) graph.get(path).add(taskNum);
  }
  for (const p of ownScope) {
    if (_entryCoversPath(entry, p)) graph.get(p).add(taskNum);
  }
}

function _applyTaskCoverage(graph, task) {
  const strat = task && task.testStrategy;
  if (!strat || typeof strat !== 'object') return;
  const kind = strat.kind;
  const ownScope = _scopeOf(task);

  if (CITATION_KINDS.has(kind)) {
    for (const p of ownScope) graph.get(p).add(task.num);
    return;
  }
  if (ENTRY_KINDS.has(kind) && typeof strat.entry === 'string' && strat.entry) {
    _applyEntryCoverage(graph, strat.entry, task.num, ownScope);
  }
}

function buildCoverageGraph(tasks) {
  /** @type {Map<string, Set<number>>} */
  const graph = new Map();
  if (!Array.isArray(tasks)) return graph;
  _seedGraph(tasks, graph);
  for (const t of tasks) _applyTaskCoverage(graph, t);
  return graph;
}

/**
 * Default three-option remediation strings, kept stable so AC15's
 * assertion text remains anchored.
 *
 * @param {object} task
 * @returns {string[]}
 */
function _remediationOptions(task) {
  const heading = (task && task.heading) || `Task ${task && task.num}`;
  return [
    `fold into peer task that already exercises this path`,
    `declare kind: wiring-citation with verified-by: <peer task> in ${heading}`,
    `add a test entry to this task (kind: unit or kind: integration with entry: <path>)`,
  ];
}

/**
 * Identify paths declared in some task's `Files in scope` that no task's
 * test strategy actually covers, OR docs-only tasks that fail the
 * wiring-citation policy.
 *
 * @param {Array<object>} tasks
 * @param {Map<string, Set<number>>} graph
 * @returns {{ path: string, owner: number, remediation: string[] }[]}
 */
function _buildOwnerMap(tasks) {
  /** @type {Map<string, object>} */
  const owners = new Map();
  for (const t of tasks) {
    for (const p of _scopeOf(t)) {
      if (typeof p === 'string' && p && !owners.has(p)) owners.set(p, t);
    }
  }
  return owners;
}

function _isOrphan(owner, coverers) {
  const ownerKind = owner.testStrategy && owner.testStrategy.kind;
  if (isDocsOnlyScope(_scopeOf(owner)) && !CITATION_KINDS.has(ownerKind)) {
    return true;
  }
  return !coverers || coverers.size === 0;
}

function findOrphanedPaths(tasks, graph) {
  /** @type {{ path: string, owner: number, remediation: string[] }[]} */
  const out = [];
  if (!Array.isArray(tasks) || !(graph instanceof Map)) return out;

  const owners = _buildOwnerMap(tasks);
  for (const [path, coverers] of graph) {
    const owner = owners.get(path);
    if (!owner) continue;
    if (_isOrphan(owner, coverers)) {
      out.push({ path, owner: owner.num, remediation: _remediationOptions(owner) });
    }
  }
  return out;
}

module.exports = {
  buildCoverageGraph,
  findOrphanedPaths,
  // Exposed for testing / docs.
  isDocsOnlyScope,
};
