/**
 * changed-test-files.js
 *
 * GH-694 — the tests-only "declared test files actually changed" rule
 * (GH-528), extracted VERBATIM from task-next.js so the implement gate's
 * GREEN writer (tdd-phase-state/gate-writer.js) applies the SAME function
 * the recorder path uses (unification invariant). Extracted as a sibling
 * module (same pattern as lib/red-load-failure.js) rather than exported
 * directly from task-next.js, which would create the circular require
 * gate-writer ← task-next → recordEvidence → tdd-phase-state → gate-writer.
 *
 * task-next.js requires and re-exports both functions, so its public
 * surface and existing tests stay byte-compatible.
 */

'use strict';

const { safeSpawnSync } = require('../../lib/safeSubprocess');

const { fileMatchesScope } = require('../../lib/task-scope');

/**
 * Pure helper: filter a list of changed POSIX paths down to those that are
 * test/spec files AND fall under the task's declared scope.
 *
 * Scope match delegates to `fileMatchesScope` from `../../lib/task-scope`
 * (the same matcher used by the production scope-protection layer), so glob
 * patterns like `src/**` or `plugins/work/**\/*.test.js` are honored.
 * Bare-directory entries (no glob meta, no trailing `/`) keep their legacy
 * "directory prefix" semantics so existing task definitions don't regress.
 *
 * Scope behaviors preserved:
 *   - exact path entry          → matches that path
 *   - directory entry (`a/b`)   → matches `a/b/**` (legacy prefix)
 *   - directory entry (`a/b/`)  → matches `a/b/**` (via fileMatchesScope)
 *   - glob entry  (`a/**\/*.test.js`) → standard glob match
 *   - empty scope               → any changed test file passes through
 *
 * The test-file extension filter always applies last: a file matched by
 * scope but not ending in `.test.<ext>` / `.spec.<ext>` is excluded.
 *
 * @param {string[]} changedPaths POSIX-style paths relative to repoRoot.
 * @param {string[]} scope        `### Files in scope` entries from tasks.md.
 * @returns {string[]}            The subset that should count as "agent
 *                                actually wrote in-scope test code".
 */
function filterChangedTestFilesByScope(changedPaths, scope) {
  const out = [];
  const scopeList = Array.isArray(scope) ? scope.filter((s) => typeof s === 'string' && s) : [];
  for (const rel of Array.isArray(changedPaths) ? changedPaths : []) {
    if (typeof rel !== 'string' || !rel) continue;
    if (!/\.(test|spec)\.[jt]sx?$/i.test(rel)) continue;
    if (scopeList.length === 0) {
      out.push(rel);
      continue;
    }
    const inScope = scopeList.some((s) => {
      if (rel === s) return true;
      // Legacy bare-directory prefix: `a/b` matches `a/b/...`. We keep this
      // because fileMatchesScope would compile `a/b` as a literal glob and
      // miss the descendants.
      if (rel.startsWith(s.replace(/\/+$/, '') + '/')) return true;
      // Delegate everything else (exact match was handled above) to the
      // shared glob-aware matcher — this is the regression fix for `**`
      // and `*` segment patterns.
      return fileMatchesScope(rel, [s]);
    });
    if (inScope) out.push(rel);
  }
  return out;
}

/**
 * Return the subset of changed (vs HEAD + staged + untracked) files that are
 * test/spec files AND fall under the task's declared scope. Used by the
 * tests-only GREEN gate to ensure the agent actually wrote new test code
 * (not a no-op cycle).
 *
 * Scope-match semantics live in `filterChangedTestFilesByScope` (pure,
 * unit-tested). This function is the git-aware wrapper that collects the
 * "changed" set from working tree + index + untracked files.
 */
function detectChangedTestFilesInScope(repoRoot, scope) {
  const out = [];
  let diff = '';
  let staged = '';
  let untracked = '';
  // GH-528 round-2 follow-up note: check `git` exit status so a real git
  // failure (corrupt repo, mid-rebase, missing git binary) is distinguishable
  // from "no changes" downstream. Without this, all three sources silently
  // return '' on error and the tests-only GREEN gate fires with the
  // misleading "No *.test.* file under scope has changes" message.
  let gitFailed = false;
  try {
    const r1 = safeSpawnSync('git', ['diff', '--name-only'], { cwd: repoRoot, encoding: 'utf8' });
    if (r1.status !== 0) gitFailed = true;
    diff = r1.stdout || '';
    const r2 = safeSpawnSync('git', ['diff', '--cached', '--name-only'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (r2.status !== 0) gitFailed = true;
    staged = r2.stdout || '';
    const r3 = safeSpawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (r3.status !== 0) gitFailed = true;
    untracked = r3.stdout || '';
  } catch {
    gitFailed = true;
  }
  if (gitFailed) {
    process.stderr.write(
      'changed-test-files: git change detection failed (corrupt repo or detached state?); ' +
        'treating changed-files as empty. Downstream gate may block with a misleading message.\n'
    );
  }
  const changed = [
    ...new Set(
      [...diff.split('\n'), ...staged.split('\n'), ...untracked.split('\n')]
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];
  return filterChangedTestFilesByScope(changed, scope).reduce((acc, rel) => {
    acc.push(rel);
    return acc;
  }, out);
}

module.exports = { filterChangedTestFilesByScope, detectChangedTestFilesInScope };
