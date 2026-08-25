/**
 * workflow-artifact-diff.js — one definition of "did the CODE change?", shared
 * by every freshness gate in /check and /work.
 *
 * ## The loop this exists to break
 *
 * `/check` keys its cycle on a changes hash (`git diff <base>...HEAD -w`) and
 * its drift gates on the HEAD sha. Both were computed over the WHOLE diff —
 * including the workflow's own artifacts. When `TASKS_BASE` points inside the
 * repository (a supported layout: `<repo>/tasks/<TICKET>/`), those artifacts
 * are tracked files, and `commit-and-push.js` — the one sanctioned commit path
 * — stages with `git add -A`. So:
 *
 *   1. phase-1 agents verify the code and write `*.check.md` — all APPROVED
 *   2. the next sanctioned commit sweeps those reports into HEAD
 *   3. the changes hash moves, though not one line of code changed
 *   4. `shouldPurgeReports` sees a new hash → purges the reports it just wrote
 *      and re-dispatches every agent; `assessTerminalState` reports `stale`;
 *      the /work check-drift gate rewinds post-check steps back to `check`
 *   5. the agents approve again, and their approval is again the input that
 *      invalidates them — goto 2
 *
 * The check's own output was an input to its freshness test, so it could never
 * converge: the agents "look again and again and again". Excluding workflow
 * artifacts from both signals makes the fixed point reachable — a re-run now
 * requires a real code change.
 *
 * ## Classification is deliberately conservative
 *
 * A source file wrongly classified as an artifact would MASK a real change and
 * let a stale approval stand — much worse than an extra re-run. So a path
 * counts as an artifact only when it is unambiguously workflow-owned:
 *
 *   1. it lives under the configured `TASKS_BASE` (that tree is workflow-owned
 *      by definition — brief.md, spec.md, tasks.md, screenshots, reports), or
 *   2. its basename is one no source tree uses (`*.check.md`, the workflow's
 *      state/verdict JSON files).
 *
 * Ambiguous names (`tasks.md`, `spec.md`, `ticket.json`) are artifacts ONLY via
 * rule 1 — a repo may legitimately ship its own `docs/tasks.md`.
 *
 * Every helper fails SAFE: when git cannot answer, callers are told the answer
 * is unknown (`known: false`) and keep their pre-existing conservative
 * behavior — treat it as changed, re-run the check.
 */

'use strict';

const path = require('node:path');

const { safeExec } = require('./safe-exec');

/**
 * Basenames that are workflow artifacts wherever they appear. Kept to names a
 * source tree would never use — see the conservatism note in the file header.
 * `.check.md` covers every report (tests/code-review/completion/qa/per-task).
 */
const ARTIFACT_BASENAME_RE =
  /(?:^|\/)(?:[^/]*\.check\.md|\.check-state\.json|\.check-cycle\.json|\.work-state\.json|completion-context\.json|completion-verdict\.json|review-accountability\.json|\.last-commit-sha)$/;

/** Pathspec globs for the rule-2 basenames — `*` spans `/` in git pathspecs. */
const ARTIFACT_PATHSPECS = [
  '*.check.md',
  '*.check-state.json',
  '.check-state.json',
  '*.check-cycle.json',
  '.check-cycle.json',
  '*.work-state.json',
  '.work-state.json',
  '*completion-context.json',
  '*completion-verdict.json',
  '*review-accountability.json',
  '*.last-commit-sha',
];

function gitOut(args, cwd) {
  return safeExec('git', args, { fallback: null, ...(cwd ? { cwd } : {}) });
}

/** Repo root for `cwd`, or null when git cannot answer. */
function repoRoot(cwd) {
  return gitOut(['rev-parse', '--show-toplevel'], cwd) || null;
}

/**
 * `TASKS_BASE` expressed relative to the repo root, or null when it is not
 * configured, not inside this repo, or git cannot resolve the root. Null is
 * the safe answer: it simply leaves rule 1 unapplied.
 *
 * @param {string} [cwd]
 * @returns {string|null} POSIX-style relative path, e.g. `tasks`
 */
function tasksBaseRelative(cwd) {
  let tasksBase;
  try {
    tasksBase = require('./config').TASKS_BASE;
  } catch {
    tasksBase = process.env.TASKS_BASE || null;
  }
  if (!tasksBase) return null;
  const root = repoRoot(cwd);
  if (!root) return null;
  const rel = path.relative(root, path.resolve(tasksBase));
  // Outside the repo (`..`) or the repo root itself (`''`) → rule 1 is off.
  // An empty rel would classify the ENTIRE repo as artifacts.
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * True when a repo-relative path is a workflow artifact rather than code.
 *
 * @param {string} relPath — repo-relative path, POSIX separators
 * @param {string|null} [tasksBaseRel] — from `tasksBaseRelative()`
 * @returns {boolean}
 */
function isWorkflowArtifactPath(relPath, tasksBaseRel) {
  const p = String(relPath || '')
    .trim()
    .split(path.sep)
    .join('/');
  if (!p) return false;
  if (tasksBaseRel && (p === tasksBaseRel || p.startsWith(`${tasksBaseRel}/`))) return true;
  return ARTIFACT_BASENAME_RE.test(p);
}

/**
 * Pathspec arguments that exclude every workflow artifact from a git diff.
 * Prefixed with `--` so callers append them straight onto an argv.
 *
 * @param {string} [cwd]
 * @returns {string[]}
 */
function artifactExcludePathspecs(cwd) {
  const specs = ['--', '.'];
  const tasksBaseRel = tasksBaseRelative(cwd);
  if (tasksBaseRel) specs.push(`:(exclude)${tasksBaseRel}`);
  for (const glob of ARTIFACT_PATHSPECS) specs.push(`:(exclude)${glob}`);
  return specs;
}

/**
 * The `<base>...HEAD` diff with workflow artifacts excluded — the input both
 * changes-hash implementations hash. Shared so the two can never drift: an
 * identical diff must yield an identical hash on both sides.
 *
 * @param {string} baseBranch — already validated by the caller
 * @param {string} [cwd]
 * @returns {string|null} diff text ('' when nothing code-relevant changed),
 *   null when there is no git repository — callers must NOT read null as "no
 *   changes". A diff command that itself fails (e.g. an unresolvable base ref)
 *   yields '' exactly as it did before this module existed.
 */
function codeRelevantDiff(baseBranch, cwd) {
  if (!gitOut(['rev-parse', '--git-dir'], cwd)) return null;
  const diff = gitOut(
    ['diff', `${baseBranch}...HEAD`, '-w', ...artifactExcludePathspecs(cwd)],
    cwd
  );
  return diff === null ? '' : diff;
}

/**
 * Files changed between two commits, artifacts filtered out.
 *
 * @param {string} fromRef
 * @param {string} toRef
 * @param {string} [cwd]
 * @returns {{ known: boolean, files: string[] }} `known:false` when git could
 *   not answer (unknown ref, no repo) — callers must fail safe.
 */
function codeRelevantChangedFiles(fromRef, toRef, cwd) {
  if (!fromRef || !toRef) return { known: false, files: [] };
  const out = gitOut(['diff', '--name-only', `${fromRef}..${toRef}`], cwd);
  if (out === null) return { known: false, files: [] };
  const tasksBaseRel = tasksBaseRelative(cwd);
  const files = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((f) => !isWorkflowArtifactPath(f, tasksBaseRel));
  return { known: true, files };
}

/**
 * Did anything code-relevant land between two commits?
 *
 * @param {string} fromRef
 * @param {string} toRef
 * @param {string} [cwd]
 * @returns {{ known: boolean, changed: boolean }} `changed` is meaningful only
 *   when `known` is true; callers treat unknown as changed (fail safe).
 */
function hasCodeRelevantChanges(fromRef, toRef, cwd) {
  const { known, files } = codeRelevantChangedFiles(fromRef, toRef, cwd);
  return { known, changed: files.length > 0 };
}

/**
 * Shared verdict for the HEAD-moved gates: is this movement real drift?
 * Artifact-only movement is not — that is the livelock in the file header.
 *
 * @param {string|null} fromSha
 * @param {string|null} toSha
 * @param {string} [cwd]
 * @returns {{ drift: boolean, artifactOnly: boolean }}
 */
function isRealHeadDrift(fromSha, toSha, cwd) {
  if (!fromSha || !toSha || fromSha === toSha) return { drift: false, artifactOnly: false };
  const { known, changed } = hasCodeRelevantChanges(fromSha, toSha, cwd);
  if (!known) return { drift: true, artifactOnly: false }; // unknown → fail safe
  return { drift: changed, artifactOnly: !changed };
}

module.exports = {
  ARTIFACT_BASENAME_RE,
  ARTIFACT_PATHSPECS,
  artifactExcludePathspecs,
  codeRelevantChangedFiles,
  codeRelevantDiff,
  hasCodeRelevantChanges,
  isRealHeadDrift,
  isWorkflowArtifactPath,
  tasksBaseRelative,
};
