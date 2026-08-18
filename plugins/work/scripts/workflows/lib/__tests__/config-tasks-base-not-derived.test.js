/**
 * config-tasks-base-not-derived.test.js
 *
 * TASKS_BASE is CONFIGURED, never derived. `lib/config.js` used to fall back to
 * `path.join(WORKTREES_BASE, 'tasks')` — the guess `resolve-base-dirs.js` (#788)
 * was written to refuse, and the last place still making it.
 *
 * The two are separate locations: worktrees live beside the repo, the tasks root
 * is wherever the operator put it. This repo's own .envrc has them as SIBLINGS,
 * so the derivation produced `<root>/worktrees/tasks` — a directory nothing
 * writes to. Because it looked valid every consumer accepted it, and the failure
 * surfaced far away as "Missing report: tests.check.md" for files that existed
 * one directory over (#791).
 *
 * Uses node:test + node:assert/strict.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const CONFIG = require.resolve('../config');

let saved;

/** Load a fresh config.js under a controlled environment. */
function freshConfig(env) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[CONFIG];
  return require(CONFIG);
}

beforeEach(() => {
  saved = { tasks: process.env.TASKS_BASE, worktrees: process.env.WORKTREES_BASE };
});

afterEach(() => {
  for (const [k, v] of [
    ['TASKS_BASE', saved.tasks],
    ['WORKTREES_BASE', saved.worktrees],
  ]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[CONFIG];
});

describe('config.TASKS_BASE is configured, never derived', () => {
  it('does NOT derive <WORKTREES_BASE>/tasks when TASKS_BASE is unset', () => {
    const config = freshConfig({ WORKTREES_BASE: '/srv/worktrees', TASKS_BASE: undefined });

    assert.equal(
      config.TASKS_BASE,
      null,
      'a wrong-but-plausible tasks dir is worse than none — it splits writers from readers'
    );
    assert.notEqual(config.TASKS_BASE, path.join('/srv/worktrees', 'tasks'));
  });

  it('tasksDir() reports "unknown" rather than a guessed path', () => {
    const config = freshConfig({ WORKTREES_BASE: '/srv/worktrees', TASKS_BASE: undefined });
    assert.equal(config.tasksDir('GH-1'), null);
  });

  it('honors an explicitly configured TASKS_BASE that is NOT under WORKTREES_BASE', () => {
    // The real layout this defect broke: siblings, not nested.
    const config = freshConfig({ WORKTREES_BASE: '/srv/worktrees', TASKS_BASE: '/srv/tasks' });

    assert.equal(config.TASKS_BASE, '/srv/tasks');
    assert.equal(config.tasksDir('GH-1'), path.join('/srv/tasks', 'GH-1'));
  });

  it('still honors TASKS_BASE when WORKTREES_BASE is absent', () => {
    const config = freshConfig({ WORKTREES_BASE: undefined, TASKS_BASE: '/srv/tasks' });
    assert.equal(config.TASKS_BASE, '/srv/tasks');
  });

  it('leaves WORKTREES_BASE derivation alone — a different, repo-anchored concept', () => {
    // worktreeDir()/repoDir() are genuinely layout-derived; only the tasks root
    // is a separately configured location. Narrowing this fix to TASKS_BASE is
    // deliberate, so pin that WORKTREES_BASE still resolves.
    const config = freshConfig({ WORKTREES_BASE: '/srv/worktrees', TASKS_BASE: undefined });
    assert.equal(config.WORKTREES_BASE, '/srv/worktrees');
    assert.equal(config.repoDir(), path.join('/srv/worktrees', config.REPO_NAME));
  });
});
