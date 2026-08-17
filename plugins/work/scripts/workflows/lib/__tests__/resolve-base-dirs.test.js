'use strict';

/**
 * TASKS_BASE is never guessed from WORKTREES_BASE.
 *
 * Before this suite's fix, both `lib/plugin-config.js` and `work/work-next.js`
 * carried `getConfig('TASKS_BASE') || path.join(WORKTREES_BASE, 'tasks')`. A
 * process that started without the environment loaded therefore resolved a
 * wrong-but-plausible tasks dir: the check orchestrator wrote reports to
 * `<worktrees>/tasks/<TICKET>/` while the work driver's gates read
 * `<repo-parent>/tasks/<TICKET>/`, and the gates reported "Missing report:
 * tests.check.md" for files that existed.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveBaseDirs } = require(path.resolve(__dirname, '..', 'resolve-base-dirs.js'));

const WORKTREES = '/home/dev/worktrees';

/** Stand-in for `lib/get-config`: `process.env[key] || config[key]`. */
function fakeGetConfig(values) {
  return (key) => values[key] || undefined;
}

/**
 * `lib/config.js` derives its own TASKS_BASE as `<WORKTREES_BASE>/tasks` when
 * the env is missing, so getConfig hands back the derivation, not a setting.
 */
function getConfigWithDerivedTasksBase(worktreesBase) {
  return fakeGetConfig({
    WORKTREES_BASE: worktreesBase,
    TASKS_BASE: path.join(worktreesBase, 'tasks'),
  });
}

/** Run a callback with TASKS_BASE/WORKTREES_BASE forced, then restore them. */
function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('resolveBaseDirs', () => {
  it('refuses to guess when WORKTREES_BASE is set but TASKS_BASE is not', () => {
    const dirs = resolveBaseDirs(getConfigWithDerivedTasksBase(WORKTREES), {});
    assert.equal(dirs.WORKTREES_BASE, WORKTREES);
    assert.equal(dirs.TASKS_BASE, '', 'TASKS_BASE must be empty, never the derived guess');
    assert.ok(dirs.error, 'expected an explanation alongside the empty TASKS_BASE');
  });

  it('names both values and points at TASKS_BASE in the explanation', () => {
    const { error } = resolveBaseDirs(getConfigWithDerivedTasksBase(WORKTREES), {});
    assert.match(error, /WORKTREES_BASE=\/home\/dev\/worktrees/);
    assert.match(error, /\/home\/dev\/worktrees\/tasks/);
    assert.match(error, /Set TASKS_BASE explicitly/);
  });

  it('trusts an explicit env TASKS_BASE even when it differs from the derivation', () => {
    const dirs = resolveBaseDirs(getConfigWithDerivedTasksBase(WORKTREES), {
      TASKS_BASE: '/srv/shared/tasks',
    });
    assert.deepEqual(dirs, {
      WORKTREES_BASE: WORKTREES,
      TASKS_BASE: '/srv/shared/tasks',
      error: null,
    });
  });

  it('accepts a config-supplied TASKS_BASE that is not the derivation', () => {
    const getConfig = fakeGetConfig({ WORKTREES_BASE: WORKTREES, TASKS_BASE: '/srv/shared/tasks' });
    assert.deepEqual(resolveBaseDirs(getConfig, {}), {
      WORKTREES_BASE: WORKTREES,
      TASKS_BASE: '/srv/shared/tasks',
      error: null,
    });
  });

  it('reports nothing extra when nothing at all is configured', () => {
    assert.deepEqual(resolveBaseDirs(fakeGetConfig({}), {}), {
      WORKTREES_BASE: '',
      TASKS_BASE: '',
      error: null,
    });
  });

  it('defaults its env argument to process.env', () => {
    withEnv({ TASKS_BASE: '/srv/from-process-env/tasks' }, () => {
      const dirs = resolveBaseDirs(getConfigWithDerivedTasksBase(WORKTREES));
      assert.equal(dirs.TASKS_BASE, '/srv/from-process-env/tasks');
    });
  });
});

describe('resolvePluginConfig (shares the same resolver)', () => {
  it('does not hand back a guessed <WORKTREES_BASE>/tasks', () => {
    const { resolvePluginConfig } = require(path.resolve(__dirname, '..', 'plugin-config.js'));
    const workDir = path.resolve(__dirname, '..', '..', 'work');
    withEnv({ TASKS_BASE: undefined, WORKTREES_BASE: WORKTREES }, () => {
      const cfg = resolvePluginConfig(workDir);
      assert.equal(cfg.WORKTREES_BASE, WORKTREES);
      assert.equal(cfg.TASKS_BASE, '', 'resolvePluginConfig must not guess a tasks dir');
      assert.match(cfg.configError, /TASKS_BASE is not configured/);
    });
  });
});

describe('work-next.js surfaces the explanation instead of running on a guess', () => {
  it('blocks with the TASKS_BASE reason when only WORKTREES_BASE is set', () => {
    const env = { ...process.env, WORKTREES_BASE: WORKTREES };
    delete env.TASKS_BASE;
    delete env.CLAUDE_PLUGIN_ROOT; // use the __dirname fallback, as the CLI tests do
    const out = execFileSync(
      process.execPath,
      [path.resolve(__dirname, '..', '..', 'work', 'work-next.js'), 'ECHO-1'],
      { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'], env }
    );
    const parsed = JSON.parse(out);
    assert.equal(parsed.action, 'blocked');
    assert.match(parsed.reason, /TASKS_BASE is not configured/);
    assert.match(parsed.reason, new RegExp(`WORKTREES_BASE=${WORKTREES}`));
    assert.doesNotMatch(parsed.reason, /Uncaught exception/);
  });
});
