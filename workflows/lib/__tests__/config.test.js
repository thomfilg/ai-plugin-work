const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

// Save original env
const originalEnv = { ...process.env };

// Keys set by config.js that we need to clean between tests
const CONFIG_KEYS = [
  'JIRA_PROJECT_KEY', 'JIRA_BASE_URL', 'JIRA_ASSIGNEE_EMAIL',
  'TICKET_PROVIDER', 'TICKET_PROJECT_KEY',
  'REPO_NAME', 'GITHUB_ORG', 'WORKTREES_BASE', 'TASKS_BASE',
  'FOLLOW_UP_PR_POLL_REVIEWS', 'BASE_BRANCH', 'WEB_APPS',
];

// Defaults matching config.js fallback values — used to block .env file loading.
// config.js's loadEnvFile() only sets keys where !process.env[key], so pre-setting
// these prevents a developer's local .env from leaking into tests.
const CONFIG_DEFAULTS = {
  JIRA_PROJECT_KEY: 'PROJ',
  JIRA_BASE_URL: 'your-org.atlassian.net',
  JIRA_ASSIGNEE_EMAIL: '',
  TICKET_PROVIDER: '',
  TICKET_PROJECT_KEY: 'PROJ',
  REPO_NAME: 'my-project',
  GITHUB_ORG: '',
  WORKTREES_BASE: `${process.env.HOME}/worktrees`,
  TASKS_BASE: `${process.env.HOME}/worktrees/tasks`,
  FOLLOW_UP_PR_POLL_REVIEWS: 'true',
  BASE_BRANCH: '',
  WEB_APPS: '[]',
};

function resetEnv() {
  for (const key of CONFIG_KEYS) delete process.env[key];
}

/**
 * Pre-populate env with config defaults to block loadEnvFile() from reading
 * a developer's local .env, then apply the caller's overrides on top.
 */
function freshRequire(envOverrides = {}) {
  // Clear module caches
  const resolved = require.resolve('../config');
  delete require.cache[resolved];
  try { delete require.cache[require.resolve('../ticket-provider')]; } catch { /* */ }

  // Block .env by pre-setting all keys to defaults
  for (const [key, val] of Object.entries(CONFIG_DEFAULTS)) {
    process.env[key] = val;
  }

  // Apply test-specific overrides (set after defaults so they take effect)
  for (const [key, val] of Object.entries(envOverrides)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }

  return require('../config');
}

describe('config', () => {
  beforeEach(() => {
    resetEnv();
  });

  after(() => {
    // Restore original environment
    for (const key of CONFIG_KEYS) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  // ─── WEB_APPS parsing ───────────────────────────────────────────────────

  describe('WEB_APPS parsing', () => {
    it('parses valid JSON array', () => {
      const config = freshRequire({
        WEB_APPS: JSON.stringify([
          { name: 'app-a', defaultPort: 3000, type: 'vite' },
          { name: 'app-b', defaultPort: 4000, type: 'remix' },
        ]),
      });
      assert.equal(config.WEB_APPS.length, 2);
      assert.equal(config.WEB_APPS[0].name, 'app-a');
      assert.equal(config.WEB_APPS[1].defaultPort, 4000);
    });

    it('returns empty array for invalid JSON', () => {
      const config = freshRequire({ WEB_APPS: 'not-json{{{' });
      assert.deepEqual(config.WEB_APPS, []);
    });

    it('returns empty array for non-array JSON', () => {
      const config = freshRequire({ WEB_APPS: '{"name":"oops"}' });
      assert.deepEqual(config.WEB_APPS, []);
    });

    it('returns empty array when WEB_APPS is default', () => {
      const config = freshRequire();
      assert.deepEqual(config.WEB_APPS, []);
    });
  });

  // ─── webAppNames ────────────────────────────────────────────────────────

  describe('webAppNames', () => {
    it('returns names from valid entries', () => {
      const config = freshRequire({
        WEB_APPS: JSON.stringify([
          { name: 'app-a', defaultPort: 3000, type: 'vite' },
          { name: 'app-b', defaultPort: 4000, type: 'remix' },
        ]),
      });
      assert.deepEqual(config.webAppNames(), ['app-a', 'app-b']);
    });

    it('skips entries without name', () => {
      const config = freshRequire({
        WEB_APPS: JSON.stringify([
          { name: 'good', defaultPort: 3000, type: 'vite' },
          { defaultPort: 4000, type: 'remix' },
          null,
          { name: '', defaultPort: 5000, type: 'vite' },
        ]),
      });
      assert.deepEqual(config.webAppNames(), ['good']);
    });

    it('returns empty array when no apps configured', () => {
      const config = freshRequire();
      assert.deepEqual(config.webAppNames(), []);
    });
  });

  // ─── webAppsMap ─────────────────────────────────────────────────────────

  describe('webAppsMap', () => {
    it('builds map from valid entries', () => {
      const config = freshRequire({
        WEB_APPS: JSON.stringify([
          { name: 'app-a', defaultPort: 3000, type: 'vite' },
        ]),
      });
      const map = config.webAppsMap();
      assert.deepEqual(map['app-a'], { defaultPort: 3000, type: 'vite' });
    });

    it('skips malformed entries (null, missing name)', () => {
      const config = freshRequire({
        WEB_APPS: JSON.stringify([
          null,
          { defaultPort: 3000 },
          { name: 'valid', defaultPort: 5000, type: 'remix' },
        ]),
      });
      const map = config.webAppsMap();
      assert.equal(Object.keys(map).length, 1);
      assert.deepEqual(map['valid'], { defaultPort: 5000, type: 'remix' });
    });

    it('returns prototype-free object', () => {
      const config = freshRequire();
      const map = config.webAppsMap();
      assert.equal(Object.getPrototypeOf(map), null);
    });
  });

  // ─── getBaseBranch ──────────────────────────────────────────────────────

  describe('getBaseBranch', () => {
    it('returns a string starting with origin/', () => {
      const config = freshRequire();
      const branch = config.getBaseBranch();
      assert.ok(branch.startsWith('origin/'), `Expected origin/ prefix, got: ${branch}`);
    });

    it('accepts cwd option', () => {
      const config = freshRequire();
      const branch = config.getBaseBranch({ cwd: process.cwd() });
      assert.ok(typeof branch === 'string');
    });

    it('sanitizes BASE_BRANCH by stripping refs/remotes/ prefix', () => {
      const config = freshRequire({ BASE_BRANCH: 'refs/remotes/origin/main' });
      const branch = config.getBaseBranch();
      assert.ok(!branch.includes('refs/remotes/'), `Should strip refs/remotes/, got: ${branch}`);
    });

    it('sanitizes BASE_BRANCH by stripping origin/ prefix', () => {
      const config = freshRequire({ BASE_BRANCH: 'origin/main' });
      const branch = config.getBaseBranch();
      assert.ok(!branch.includes('origin/origin/'), `Double origin/ prefix, got: ${branch}`);
    });

    it('strips special characters from BASE_BRANCH', () => {
      const config = freshRequire({ BASE_BRANCH: 'main; rm -rf /' });
      const branch = config.getBaseBranch();
      assert.ok(!branch.includes(';'), `Should strip semicolons, got: ${branch}`);
      assert.ok(!branch.includes(' '), `Should strip spaces, got: ${branch}`);
    });

    it('rejects revspec operators (..)', () => {
      const config = freshRequire({ BASE_BRANCH: 'main..HEAD' });
      const branch = config.getBaseBranch();
      assert.ok(!branch.includes('..'), `Should reject revspec, got: ${branch}`);
    });

    it('falls through when BASE_BRANCH ref does not exist', () => {
      const config = freshRequire({ BASE_BRANCH: 'nonexistent-branch-xyz-999' });
      const branch = config.getBaseBranch();
      assert.notEqual(branch, 'origin/nonexistent-branch-xyz-999');
    });

    it('returns fallback origin/main when nothing else works', () => {
      const config = freshRequire();
      const branch = config.getBaseBranch({ cwd: '/tmp' });
      assert.equal(branch, 'origin/main');
    });
  });

  // ─── prefixTicketId ─────────────────────────────────────────────────────

  describe('prefixTicketId', () => {
    it('prefixes numeric input with TICKET_PROJECT_KEY', () => {
      const config = freshRequire({ TICKET_PROJECT_KEY: 'MYPROJ' });
      assert.equal(config.prefixTicketId('123'), 'MYPROJ-123');
    });

    it('uppercases non-numeric input', () => {
      const config = freshRequire();
      assert.equal(config.prefixTicketId('proj-456'), 'PROJ-456');
    });
  });

  // ─── Path helpers ───────────────────────────────────────────────────────

  describe('path helpers', () => {
    it('worktreeDir uses REPO_NAME and ticket', () => {
      const config = freshRequire({ REPO_NAME: 'test-repo', WORKTREES_BASE: '/tmp/wt' });
      assert.equal(config.worktreeDir('PROJ-1'), '/tmp/wt/test-repo-PROJ-1');
    });

    it('tasksDir uses TASKS_BASE', () => {
      const config = freshRequire({ TASKS_BASE: '/tmp/tasks' });
      assert.equal(config.tasksDir('PROJ-1'), '/tmp/tasks/PROJ-1');
    });

    it('repoDir uses WORKTREES_BASE and REPO_NAME', () => {
      const config = freshRequire({ WORKTREES_BASE: '/tmp/wt', REPO_NAME: 'my-repo' });
      assert.equal(config.repoDir(), '/tmp/wt/my-repo');
    });
  });
});
