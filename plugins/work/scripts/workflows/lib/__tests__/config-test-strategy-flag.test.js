const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Save original env
const originalEnv = { ...process.env };

const FLAG_KEY = 'WORK_TEST_STRATEGY_VALIDATOR';

// Keys touched by config.js that we want to clean between tests so that
// loadEnvFile() does not leak a developer's local .env into the assertions.
const CONFIG_KEYS = [
  'JIRA_PROJECT_KEY',
  'JIRA_BASE_URL',
  'JIRA_ASSIGNEE_EMAIL',
  'TICKET_PROVIDER',
  'TICKET_PROJECT_KEY',
  'REPO_NAME',
  'GITHUB_ORG',
  'WORKTREES_BASE',
  'TASKS_BASE',
  'FOLLOW_UP_PR_POLL_REVIEWS',
  'BASE_BRANCH',
  'WEB_APPS',
  'ENABLE_SYMLINK',
  FLAG_KEY,
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
  ENABLE_SYMLINK: '0',
};

function resetEnv() {
  for (const key of CONFIG_KEYS) delete process.env[key];
}

function freshRequire(envOverrides = {}) {
  const resolved = require.resolve('../config');
  delete require.cache[resolved];
  try {
    delete require.cache[require.resolve('../ticket-provider')];
  } catch {
    /* */
  }
  // Pre-populate defaults so loadEnvFile() does not pick up developer .env values.
  for (const [k, v] of Object.entries(CONFIG_DEFAULTS)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  // Apply caller-provided overrides (these may be undefined to mean "leave unset").
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  return require('../config');
}

describe('config — WORK_TEST_STRATEGY_VALIDATOR feature flag (AC17)', () => {
  beforeEach(() => {
    resetEnv();
  });

  afterEach(() => {
    resetEnv();
    // Restore original env
    for (const [k, v] of Object.entries(originalEnv)) {
      process.env[k] = v;
    }
  });

  it('defaults to "0" when WORK_TEST_STRATEGY_VALIDATOR is unset', () => {
    const config = freshRequire({ [FLAG_KEY]: undefined });
    assert.equal(
      config.WORK_TEST_STRATEGY_VALIDATOR,
      '0',
      'flag should default to "0" (off) when env var is not set',
    );
  });

  it('reads "1" from env to toggle the flag on', () => {
    const config = freshRequire({ [FLAG_KEY]: '1' });
    assert.equal(
      config.WORK_TEST_STRATEGY_VALIDATOR,
      '1',
      'flag should be "1" when WORK_TEST_STRATEGY_VALIDATOR=1',
    );
  });

  it('reads "0" from env and stays off', () => {
    const config = freshRequire({ [FLAG_KEY]: '0' });
    assert.equal(
      config.WORK_TEST_STRATEGY_VALIDATOR,
      '0',
      'flag should be "0" when WORK_TEST_STRATEGY_VALIDATOR=0',
    );
  });

  it('is exposed via config.get("WORK_TEST_STRATEGY_VALIDATOR") accessor', () => {
    const config = freshRequire({ [FLAG_KEY]: '1' });
    assert.equal(
      config.get('WORK_TEST_STRATEGY_VALIDATOR'),
      '1',
      'config.get() should read the flag from env/config',
    );
  });
});
