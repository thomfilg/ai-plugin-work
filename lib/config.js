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
  const locations = [
    path.join(__dirname, '..', '.env'),
    path.join(process.cwd(), '.env'),
  ];

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
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
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
  WORKTREES_BASE: process.env.WORKTREES_BASE || `${process.env.HOME}/worktrees`,
  TASKS_BASE: process.env.TASKS_BASE || `${process.env.HOME}/worktrees/tasks`,
  FOLLOW_UP_PR_POLL_REVIEWS: (process.env.FOLLOW_UP_PR_POLL_REVIEWS || 'true').toLowerCase() === 'true',

  // Base branch — each repo can set this (e.g., 'dev', 'main', 'master')
  // Used as last-resort fallback when git symbolic-ref detection fails
  // Example .env: BASE_BRANCH=dev
  BASE_BRANCH: process.env.BASE_BRANCH || '',

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

config.jiraBrowseUrl = (ticketId) =>
  `https://${config.JIRA_BASE_URL}/browse/${ticketId}`;

config.ticketBrowseUrl = (ticketId) => {
  const tp = require('./ticket-provider');
  const providerConfig = tp.getProviderConfig({ skipPrompt: true });
  if (providerConfig) return tp.ticketUrl(ticketId, providerConfig);
  return config.jiraBrowseUrl(ticketId);
};

config.worktreeDir = (ticketId) =>
  path.join(config.WORKTREES_BASE, `${config.REPO_NAME}-${ticketId}`);

config.repoDir = () =>
  path.join(config.WORKTREES_BASE, config.REPO_NAME);

config.tasksDir = (ticketId) =>
  path.join(config.TASKS_BASE, ticketId);

config.webAppNames = () =>
  config.WEB_APPS.map(app => app.name);

config.webAppsMap = () => {
  const map = Object.create(null);
  for (const app of config.WEB_APPS) {
    map[app.name] = { defaultPort: app.defaultPort, type: app.type };
  }
  return map;
};

/**
 * Detect the correct base branch for the repository.
 * Priority: repo config (BASE_BRANCH) → git symbolic-ref → probe common names → fallback
 */
config.getBaseBranch = () => {
  const safeExec = (cmd) => {
    try { return execSync(cmd, { encoding: 'utf8' }).trim(); } catch { return ''; }
  };

  // 1. Explicit repo config (highest priority) — sanitize to prevent shell injection
  if (config.BASE_BRANCH) {
    const sanitized = config.BASE_BRANCH.replace(/[^a-zA-Z0-9._\-/]/g, '');
    return `origin/${sanitized}`;
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

module.exports = config;
