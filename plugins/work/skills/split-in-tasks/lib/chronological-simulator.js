'use strict';

/**
 * chronological-simulator — Pass A.
 *
 * Replays each task's deliverable text in order, mutating a projected file
 * tree by recognising add/remove verbs. For every Task N+1 RED assertion,
 * checks whether the assertion's filepath subject already holds on the
 * projected tree-after-N. When it does, emits one SPLIT-WARNING with the
 * "merge-with-prior-task or convert-to-verification-checkpoint" hint.
 *
 * Pure module. No I/O. No console.*. No process.exit. No runtime deps.
 *
 * @typedef {{phase: 'RED'|'GREEN'|'REFACTOR', text: string}} Deliverable
 * @typedef {{id: number, title: string, deliverables: Deliverable[], redAssertions: string[]}} ParsedTask
 * @typedef {{kind: 'A', file: string, message: string, hint: string}} Warning
 */

/**
 * Mutation-verb regex table.
 *
 * The spec (Task 3 Deliverable 3.1, Requirements R1/R8) fixes the set of
 * verbs that the chronological simulator must recognise. Each entry below
 * documents the verbs it matches; keep them in sync with the spec — adding
 * a new verb is a behaviour change, not a refactor.
 *
 *  - `REMOVE_VERB_RE` matches: delete, remove, scrub, drop, unlink
 *  - `ADD_VERB_RE`    matches: create, add, introduce, new file
 *
 * `PATH_TOKEN_RE` captures quoted/backticked paths first (group 1) and falls
 * back to bare dotted tokens (group 2) so that prose like
 * "delete `surfaces/foo.ts`" and "create surfaces/new-thing.ts" both yield
 * the path token without dragging in surrounding English.
 */
const REMOVE_VERB_RE = /\b(delete|remove|scrub|drop|unlink)\b/i;
const ADD_VERB_RE = /\b(create|add|introduce|new file)\b/i;
const PATH_TOKEN_RE = /[`'"]([^`'"\s]+)[`'"]|([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/g;

const HINT_TEXT = 'merge-with-prior-task or convert-to-verification-checkpoint';

/**
 * Pull plausible file paths from a deliverable line. Prefers quoted/backticked
 * paths, then falls back to bare tokens that include an extension.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractPaths(text) {
  const found = [];
  let m;
  PATH_TOKEN_RE.lastIndex = 0;
  while ((m = PATH_TOKEN_RE.exec(text)) !== null) {
    const candidate = m[1] || m[2];
    if (candidate) found.push(candidate);
  }
  return found;
}

/**
 * Apply one deliverable's mutations to a working set of file paths.
 *
 * @param {Set<string>} tree
 * @param {Deliverable} deliverable
 */
function applyDeliverable(tree, deliverable) {
  if (!deliverable || typeof deliverable.text !== 'string') return;
  const text = deliverable.text;
  const paths = extractPaths(text);
  if (paths.length === 0) return;
  const isRemove = REMOVE_VERB_RE.test(text);
  const isAdd = ADD_VERB_RE.test(text);
  if (isRemove) {
    for (const p of paths) tree.delete(p);
  } else if (isAdd) {
    for (const p of paths) tree.add(p);
  }
}

/**
 * Decide whether a RED assertion already holds on the projected tree.
 *
 * The assertion-matching heuristic has three gates, applied in order:
 *
 *  1. **Subject extraction** — pull file paths from the assertion text via
 *     `extractPaths`. No path tokens → cannot decide → return false.
 *  2. **Absence claim** — the assertion must read like a "file is gone"
 *     check. We match three families of English/JS phrasing:
 *       (a) verb forms: "no longer exists", "has been removed", "is gone",
 *           "removed", "deleted", "absent"
 *       (b) the `existsSync(...) returns false` idiom (with or without the
 *           literal word "returns")
 *       (c) "asserts that … has been removed / no longer …" prose
 *     If none match, the RED isn't claiming absence → return false.
 *  3. **Tree state** — for any extracted path, if it is **missing** from
 *     the projected tree-after-N, the absence claim already holds → the
 *     RED is a no-op → return true.
 *
 * The heuristic deliberately errs on the side of false negatives: a
 * partially-recognised RED prefers silence over a noisy warning (R8).
 *
 * @param {string} text
 * @param {Set<string>} projected
 * @returns {boolean}
 */
function assertionAlreadyHolds(text, projected) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const paths = extractPaths(text);
  if (paths.length === 0) return false;
  const claimsAbsent =
    /\b(no longer exists?|has been removed|is gone|removed|deleted|absent)\b/i.test(text) ||
    /existsSync\([^)]*\)\s*(returns?\s*)?false/i.test(text) ||
    /assert(?:s|ed)?\s+that\s+.+(has been removed|no longer)/i.test(text);
  if (!claimsAbsent) return false;
  for (const p of paths) {
    if (!projected.has(p)) return true;
  }
  return false;
}

/**
 * Build chronological snapshots by applying each task's GREEN deliverables in order.
 *
 * @param {ParsedTask[]} tasks
 * @param {string[]} initial
 * @returns {Map<number, Set<string>>}
 */
function buildSnapshots(tasks, initial) {
  const snapshots = new Map();
  const current = new Set(initial);
  snapshots.set(0, new Set(current));
  for (const task of tasks) {
    if (!task || !Array.isArray(task.deliverables)) continue;
    for (const d of task.deliverables) {
      if (d && d.phase === 'GREEN') applyDeliverable(current, d);
    }
    snapshots.set(task.id, new Set(current));
  }
  return snapshots;
}

/**
 * Check a single task's RED assertions against the projected tree, returning
 * the first empty-RED warning encountered (or null).
 *
 * @param {ParsedTask} task
 * @param {Set<string>} projected
 * @param {number|string} priorId
 * @returns {Warning|null}
 */
function detectEmptyRed(task, projected, priorId) {
  const reds = Array.isArray(task.redAssertions) ? task.redAssertions : [];
  for (const redText of reds) {
    if (!assertionAlreadyHolds(redText, projected)) continue;
    const paths = extractPaths(redText);
    return {
      kind: 'A',
      file: paths[0] || '',
      message: `Task ${task.id} RED assertion already holds on the projected tree after Task ${priorId} — empty RED detected`,
      hint: HINT_TEXT,
    };
  }
  return null;
}

/**
 * Run Pass A over a parsed task list.
 *
 * @param {{tasks: ParsedTask[], initialTree: string[]}} input
 * @returns {{warnings: Warning[], projectedTreeAfter: (n: number) => string[]}}
 */
function collectWarnings(tasks, snapshots) {
  const warnings = [];
  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i];
    if (!task) continue;
    const priorId = i === 0 ? 0 : (tasks[i - 1]?.id ?? 0);
    const projected = snapshots.get(priorId) || new Set();
    const w = detectEmptyRed(task, projected, priorId);
    if (w) warnings.push(w);
  }
  return warnings;
}

function simulate(input) {
  const tasks = Array.isArray(input && input.tasks) ? input.tasks : [];
  const initial = Array.isArray(input && input.initialTree) ? input.initialTree : [];
  const snapshots = buildSnapshots(tasks, initial);
  const warnings = collectWarnings(tasks, snapshots);
  return {
    warnings,
    projectedTreeAfter(n) {
      const snap = snapshots.get(n);
      return snap ? Array.from(snap) : [];
    },
  };
}

module.exports = {
  simulate,
  REMOVE_VERB_RE,
  ADD_VERB_RE,
};
