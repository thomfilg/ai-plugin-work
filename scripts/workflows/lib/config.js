#!/usr/bin/env node

/**
 * config.js
 *
 * Centralized configuration loader for the work-workflow plugin.
 * Resolution order: .env file → environment variables → defaults
 *
 * Usage:
 *   const config = require('./config');
 *   console.log(config.JIRA_PROJECT_KEY); // e.g., 'MYPROJ'
 *   console.log(config.REPO_NAME);        // e.g., 'my-project'
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── .env Loader ────────────────────────────────────────────────────────────

function loadEnvFile() {
  const locations = [path.join(__dirname, '..', '..', '..', '.env'), path.join(process.cwd(), '.env')];

  for (const envPath of locations) {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
      break;
    }
  }
}

loadEnvFile();

// ─── Configuration ──────────────────────────────────────────────────────────

const config = {
  // Legacy Jira vars (backward compatible)
  JIRA_PROJECT_KEY: process.env.JIRA_PROJECT_KEY || 'PROJ',
  JIRA_BASE_URL: process.env.JIRA_BASE_URL || 'your-org.atlassian.net',
  JIRA_ASSIGNEE_EMAIL: process.env.JIRA_ASSIGNEE_EMAIL || '',

  // Provider-agnostic aliases (fall back to Jira vars for backward compat)
  TICKET_PROVIDER: process.env.TICKET_PROVIDER || (process.env.JIRA_PROJECT_KEY ? 'jira' : ''),
  TICKET_PROJECT_KEY: process.env.TICKET_PROJECT_KEY || process.env.JIRA_PROJECT_KEY || 'PROJ',

  REPO_NAME: process.env.REPO_NAME || 'my-project',
  GITHUB_ORG: process.env.GITHUB_ORG || '',
  WORKTREES_BASE:
    process.env.WORKTREES_BASE ||
    (() => {
      try {
        const repoRoot = execSync('git rev-parse --show-toplevel', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        return path.dirname(repoRoot);
      } catch {
        return null; // Fail open — downstream helpers are null-safe, hooks use getConfig.orExit()
      }
    })(),
  TASKS_BASE: null, // set below after WORKTREES_BASE is resolved
  ENABLE_SYMLINK: process.env.ENABLE_SYMLINK ?? '0',
  FOLLOW_UP_PR_POLL_REVIEWS:
    (process.env.FOLLOW_UP_PR_POLL_REVIEWS || 'true').toLowerCase() === 'true',

  // Comma-separated relative paths to docs agents should read during their workflows
  // Example: .rulesync/rules/code-quality.md,.rulesync/rules/types.md
  READ_DOCS_ON_REVIEW: process.env.READ_DOCS_ON_REVIEW || '',
  READ_DOCS_ON_QA: process.env.READ_DOCS_ON_QA || '',
  READ_DOCS_ON_DEV: process.env.READ_DOCS_ON_DEV || '',
  READ_DOCS_ON_E2E: process.env.READ_DOCS_ON_E2E || '',
  READ_DOCS_ON_TEST: process.env.READ_DOCS_ON_TEST || '',
  READ_DOCS_ON_STORYBOOK: process.env.READ_DOCS_ON_STORYBOOK || '',
  READ_DOCS_ON_PR: process.env.READ_DOCS_ON_PR || '',
  READ_DOCS_ON_BRIEF: process.env.READ_DOCS_ON_BRIEF || '',
  READ_DOCS_ON_SPEC: process.env.READ_DOCS_ON_SPEC || '',

  // Base branch — each repo can set this (e.g., 'dev', 'main', 'master')
  // Used as last-resort fallback when git symbolic-ref detection fails
  // Example .env: BASE_BRANCH=dev
  BASE_BRANCH: process.env.BASE_BRANCH || '',

  // Custom commands per repo — override defaults for non-standard project setups
  // Example .env:
  //   DEV_COMMAND=~/g2i/scripts/dev-squire.sh    (start dev environment)
  //   TEST_COMMAND=pnpm vitest run                (run tests)
  //   LINT_COMMAND=pnpm biome check               (run linter)
  //   TYPECHECK_COMMAND=pnpm tsc --noEmit         (run type checker)
  DEV_COMMAND: process.env.DEV_COMMAND || '',
  TEST_COMMAND: process.env.TEST_COMMAND || '',
  LINT_COMMAND: process.env.LINT_COMMAND || '',
  TYPECHECK_COMMAND: process.env.TYPECHECK_COMMAND || '',

  // Web apps list — each repo defines its own via WEB_APPS env var (JSON)
  // Example .env: WEB_APPS='[{"name":"my-app","defaultPort":3000,"type":"vite"}]'
  // Fields per app: name (string), defaultPort (number), type (string: "vite"|"remix")
  WEB_APPS: (() => {
    try {
      const parsed = JSON.parse(process.env.WEB_APPS || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })(),
};

// Derive TASKS_BASE from resolved WORKTREES_BASE — null-safe (hooks use getConfig.orExit)
config.TASKS_BASE =
  process.env.TASKS_BASE ||
  (config.WORKTREES_BASE ? path.join(config.WORKTREES_BASE, 'tasks') : null);

config.jiraBrowseUrl = (ticketId) => `https://${config.JIRA_BASE_URL}/browse/${ticketId}`;

config.ticketBrowseUrl = (ticketId) => {
  const tp = require('./ticket-provider');
  const providerConfig = tp.getProviderConfig({ skipPrompt: true });
  if (providerConfig) return tp.ticketUrl(ticketId, providerConfig);
  return config.jiraBrowseUrl(ticketId);
};

config.worktreeDir = (ticketId) =>
  config.WORKTREES_BASE
    ? path.join(config.WORKTREES_BASE, `${config.REPO_NAME}-${ticketId}`)
    : null;

config.repoDir = () =>
  config.WORKTREES_BASE ? path.join(config.WORKTREES_BASE, config.REPO_NAME) : null;

/**
 * Sanitize ticket ID for file-system paths (#N → GH-N for GitHub Issues).
 * Cached: provider config is resolved once per process.
 */
let _cachedProviderConfig;
let _providerConfigLoaded = false;
config.safeTicketId = (ticketId) => {
  try {
    if (!_providerConfigLoaded) {
      const tp = require('./ticket-provider');
      _cachedProviderConfig = tp.getProviderConfig({ skipPrompt: true });
      _providerConfigLoaded = true;
    }
    const tp = require('./ticket-provider');
    return tp.sanitizeTicketIdForPath(ticketId, _cachedProviderConfig);
  } catch {
    return ticketId;
  }
};

config.tasksDir = (ticketId) => {
  if (!config.TASKS_BASE) return null;
  return path.join(config.TASKS_BASE, config.safeTicketId(ticketId));
};

config.webAppNames = () => config.WEB_APPS.filter((app) => app && app.name).map((app) => app.name);

config.webAppsMap = () => {
  const map = Object.create(null);
  for (const app of config.WEB_APPS) {
    if (!app || !app.name) continue;
    const appType = app.appType || 'web';
    map[app.name] = {
      defaultPort: app.defaultPort,
      type: app.type,
      appType,
      healthEndpoint: app.healthEndpoint || (appType === 'api' ? '/health' : '/'),
      startCommand: app.startCommand || `pnpm dev --filter=${app.name}`,
    };
  }
  return map;
};

/**
 * Detect the correct base branch for the repository.
 * Priority: repo config (BASE_BRANCH) → git symbolic-ref → probe common names → fallback
 * @param {object} [options] - Optional settings
 * @param {string} [options.cwd] - Working directory for git commands
 */
config.getBaseBranch = (options = {}) => {
  const cwd = options.cwd || undefined;
  const safeExec = (cmd) => {
    try {
      return execSync(cmd, { encoding: 'utf8', cwd }).trim();
    } catch {
      return '';
    }
  };

  // 1. Explicit repo config (highest priority) — sanitize to prevent shell injection
  if (config.BASE_BRANCH) {
    const sanitized = config.BASE_BRANCH.replace(/^refs\/remotes\//, '')
      .replace(/^origin\//, '')
      .replace(/[^a-zA-Z0-9._\-/]/g, '')
      .replace(/\.{2,}/g, ''); // reject git revspec operators (.., ...)
    if (sanitized) {
      const ref = `origin/${sanitized}`;
      if (safeExec(`git rev-parse --verify ${ref} 2>/dev/null`)) return ref;
    }
    // Invalid or non-existent BASE_BRANCH — fall through to auto-detection
  }

  // 2. Git symbolic ref detection
  const headRef = safeExec('git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null');
  if (headRef) return headRef.replace('refs/remotes/', '');

  // 3. Probe common branch names
  for (const branch of ['origin/main', 'origin/dev', 'origin/master']) {
    if (safeExec(`git rev-parse --verify ${branch} 2>/dev/null`)) return branch;
  }

  return 'origin/main';
};

config.prefixTicketId = (input) => {
  if (/^\d+$/.test(input)) {
    return `${config.TICKET_PROJECT_KEY}-${input}`;
  }
  return input.toUpperCase();
};

/**
 * Safe config getter — env var takes priority over config value.
 * Use from files that may fail to load config.js (hooks, agents).
 *
 * @param {string} key - Config key (e.g., 'TASKS_BASE', 'WORKTREES_BASE')
 * @param {object} [_cfg] - Optional pre-loaded config object (for files that already loaded config with try/catch)
 * @returns {string|undefined}
 */
config.get = function get(key, _cfg) {
  return process.env[key] || _cfg?.[key] || config[key];
};

module.exports = config;
