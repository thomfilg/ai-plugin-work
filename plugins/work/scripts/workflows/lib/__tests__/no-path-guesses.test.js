/**
 * no-path-guesses.test.js — the burn-down guard.
 *
 * Base directories are CONFIGURED, never invented. Removing a guess only stays
 * removed if reintroducing one fails, so this scans production source for the
 * shapes that kept coming back:
 *
 *   1. `path.join(<anything>, 'tasks')` — the tasks root is TASKS_BASE. Every
 *      variant of this shipped at some point: `<WORKTREES_BASE>/tasks`
 *      (#788/#792), `~/worktrees/tasks`, `<cwd>/tasks`, `<repo-parent>/tasks`,
 *      and `<worktree>/tasks`. They differ only in what they anchor to; all
 *      produce a plausible path with no relation to the operator's layout, and
 *      because it looks valid the caller reads and writes in the wrong place.
 *
 *   2. `` `${...}-${ticket}` `` worktree naming built inline — that convention
 *      belongs to resolve-base-dirs.worktreeDirFrom() alone.
 *
 *   3. The literal placeholder 'my-project' in a path expression — it is the
 *      documentation example, and joining it produced
 *      `<worktrees>/my-project-<TICKET>`.
 *
 * The guard is deliberately grep-shaped rather than behavioural: the failure it
 * prevents is a NEW call site, and no behavioural test covers code nobody has
 * written yet. Same approach as the agent-identity grep-guard.
 *
 * ALLOWED lists the resolvers themselves — they are where the convention is
 * allowed to exist. Adding a file to it needs a reason in review.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');
const SCAN_ROOTS = [path.join(REPO_ROOT, 'plugins')];

/** The modules that legitimately own a base-dir convention. */
const ALLOWED = new Set(
  [
    // The single source of truth for WORKTREES_BASE/TASKS_BASE + derived paths.
    'plugins/work/scripts/workflows/lib/resolve-base-dirs.js',
    // maestro's equivalent single resolver.
    'plugins/maestro/scripts/lib/maestro-conduct/shared/base-dirs.js',
    // Reads TASKS_BASE and exposes tasksDir()/worktreeDir()/repoDir().
    'plugins/work/scripts/workflows/lib/config.js',
    // Read-only pointer at the PRE-FIX layout so stranded reports stay
    // discoverable (#791). Never used to resolve a working path.
    'plugins/work/scripts/workflows/check/hooks/check-setup.js',
  ].map((p) => p.split('/').join(path.sep))
);

const SKIP_DIR = new Set(['node_modules', '__tests__', 'tests', '.git']);

function collectSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name)) continue;
      collectSourceFiles(full, out);
    } else if (
      entry.name.endsWith('.js') &&
      !entry.name.endsWith('.test.js') &&
      !entry.name.endsWith('.spec.js')
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Strip comments so prose ABOUT a removed guess never trips the guard. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function scan(pattern) {
  const hits = [];
  for (const root of SCAN_ROOTS) {
    if (!fs.existsSync(root)) continue;
    for (const file of collectSourceFiles(root)) {
      const rel = path.relative(REPO_ROOT, file);
      if (ALLOWED.has(rel)) continue;
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      code.split('\n').forEach((line, i) => {
        if (pattern.test(line)) hits.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
  }
  return hits;
}

describe('no path guesses', () => {
  it('nothing builds a tasks root by joining "tasks" onto another directory', () => {
    // `path.join(<expr>, 'tasks')` / `path.resolve(<expr>, 'tasks')`.
    const hits = scan(/path\.(join|resolve)\([^)]*['"]tasks['"]/);
    assert.deepEqual(
      hits,
      [],
      'The tasks root is TASKS_BASE — resolve it via config.tasksDir(), ' +
        'resolveBaseDirs(), or ticket-validation.requireTasksBase(). ' +
        `Offenders:\n${hits.join('\n')}`
    );
  });

  it('nothing builds a worktree path from the <repo>-<ticket> convention inline', () => {
    // Two plain interpolations joined by a hyphen. `[^`(]` excludes call
    // expressions so unrelated composed FILENAMES (e.g. `${Date.now()}-${file}`
    // for an archive entry) are not mistaken for the worktree convention.
    const hits = scan(/path\.(join|resolve)\([^)]*`\$\{[^`(]*\}-\$\{[^`(]*\}`/);
    assert.deepEqual(
      hits,
      [],
      'Use resolve-base-dirs.worktreeDirFrom() (or config.worktreeDir()) — the ' +
        `one place that naming convention lives. Offenders:\n${hits.join('\n')}`
    );
  });

  it("the 'my-project' placeholder never reaches a path", () => {
    const hits = scan(/['"]my-project['"]/);
    assert.deepEqual(
      hits,
      [],
      "'my-project' is the documentation example. Joining it yields " +
        '`<worktrees>/my-project-<TICKET>`, which looks like a real worktree. ' +
        `Use resolve-base-dirs.configuredRepoName(). Offenders:\n${hits.join('\n')}`
    );
  });

  it('nothing derives a base directory from the home directory', () => {
    // `~/worktrees` and `~/worktrees/tasks` were both live. A user's home is
    // not the project layout. (Real caches under ~/.cache are unaffected: the
    // pattern requires 'worktrees' or 'tasks' as the joined segment.)
    const hits = scan(
      /(homedir\(\)|process\.env\.HOME|USERPROFILE)[^\n]*['"](worktrees|tasks)['"]/
    );
    assert.deepEqual(
      hits,
      [],
      'Base dirs come from WORKTREES_BASE/TASKS_BASE, never from $HOME. ' +
        `Offenders:\n${hits.join('\n')}`
    );
  });
});
