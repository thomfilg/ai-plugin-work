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
  JIRA_PROJECT_KEY: process.env.JIRA_PROJECT_KEY || 'PROJ',
  JIRA_BASE_URL: process.env.JIRA_BASE_URL || 'your-org.atlassian.net',
  JIRA_ASSIGNEE_EMAIL: process.env.JIRA_ASSIGNEE_EMAIL || '',
  REPO_NAME: process.env.REPO_NAME || 'my-project',
  GITHUB_ORG: process.env.GITHUB_ORG || '',
  WORKTREES_BASE: process.env.WORKTREES_BASE || `${process.env.HOME}/worktrees`,
  TASKS_BASE: process.env.TASKS_BASE || `${process.env.HOME}/worktrees/tasks`,
};

config.jiraBrowseUrl = (ticketId) =>
  `https://${config.JIRA_BASE_URL}/browse/${ticketId}`;

config.worktreeDir = (ticketId) =>
  path.join(config.WORKTREES_BASE, `${config.REPO_NAME}-${ticketId}`);

config.repoDir = () =>
  path.join(config.WORKTREES_BASE, config.REPO_NAME);

config.tasksDir = (ticketId) =>
  path.join(config.TASKS_BASE, ticketId);

config.prefixTicketId = (input) => {
  if (/^\d+$/.test(input)) {
    return `${config.JIRA_PROJECT_KEY}-${input}`;
  }
  return input.toUpperCase();
};

module.exports = config;
