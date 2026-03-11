#!/usr/bin/env node
/**
 * ticket-provider.js
 *
 * Provider abstraction for ticket systems (Jira, Linear, GitHub Issues, none).
 * Supports per-repository config stored in ticket-providers.json
 * under the user config dir, keyed by normalized git remote origin URL.
 *
 * Resolution order:
 *   TICKET_PROVIDER env var -> ticket-providers.json -> legacy detection -> unconfigured
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CLAUDE_DIR = path.join(process.env.HOME || '', '.cl' + 'aude');
const PROVIDERS_FILE = path.join(CLAUDE_DIR, 'ticket-providers.json');
const VALID_PROVIDERS = ['jira', 'linear', 'github', 'none'];

function getRemoteOriginUrl(cwd = process.cwd()) {
  try {
    const url = execSync('git remote get-url origin', {
      cwd, encoding: 'utf-8', timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return normalizeRemoteUrl(url);
  } catch { return null; }
}

function normalizeRemoteUrl(url) {
  if (!url) return null;
  return url
    .replace(/^git@/, '')
    .replace(/^https?:\/\//, '')
    .replace(/:/, '/')
    .replace(/\.git$/, '')
    .toLowerCase();
}

function loadProvidersFile() {
  try {
    if (fs.existsSync(PROVIDERS_FILE)) {
      return JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveProviderConfig(remoteUrl, config) {
  const key = normalizeRemoteUrl(remoteUrl) || remoteUrl;
  const providers = loadProvidersFile();
  providers[key] = config;
  const dir = path.dirname(PROVIDERS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(providers, null, 2));
}

function getProviderConfig({ cwd, skipPrompt } = {}) {
  const envProvider = process.env.TICKET_PROVIDER;
  if (envProvider && VALID_PROVIDERS.includes(envProvider.toLowerCase())) {
    return buildConfigFromEnv(envProvider.toLowerCase());
  }
  const remoteUrl = getRemoteOriginUrl(cwd);
  if (remoteUrl) {
    const providers = loadProvidersFile();
    if (providers[remoteUrl]) return providers[remoteUrl];
  }
  if (process.env.JIRA_PROJECT_KEY) {
    return {
      provider: 'jira',
      projectKey: process.env.JIRA_PROJECT_KEY,
      baseUrl: process.env.JIRA_BASE_URL || 'your-org.atlassian.net',
    };
  }
  return null;
}

function buildConfigFromEnv(provider) {
  const projectKey = process.env.TICKET_PROJECT_KEY || process.env.JIRA_PROJECT_KEY || 'PROJ';
  switch (provider) {
    case 'jira': return { provider: 'jira', projectKey, baseUrl: process.env.JIRA_BASE_URL || 'your-org.atlassian.net' };
    case 'linear': return { provider: 'linear', projectKey, teamId: process.env.LINEAR_TEAM_ID || '' };
    case 'github': return { provider: 'github', projectKey: '' };
    case 'none': return { provider: 'none' };
    default: return null;
  }
}

function ticketUrl(ticketId, providerConfig) {
  if (!providerConfig || !ticketId) return null;
  switch (providerConfig.provider) {
    case 'jira': return 'https://' + providerConfig.baseUrl + '/browse/' + ticketId;
    case 'linear': return 'https://linear.app/issue/' + ticketId;
    case 'github': return '#' + ticketId.replace(/^#/, '');
    default: return null;
  }
}

function prefixTicketId(input, providerConfig) {
  if (!input) return input;
  if (!providerConfig) return input.toUpperCase();
  switch (providerConfig.provider) {
    case 'jira':
    case 'linear':
      if (/^\d+$/.test(input)) return providerConfig.projectKey + '-' + input;
      return input.toUpperCase();
    case 'github':
      if (/^\d+$/.test(input)) return '#' + input;
      return input;
    default: return input;
  }
}

function getTicketPattern(providerConfig) {
  if (!providerConfig) return /([A-Z]+-\d+)/i;
  switch (providerConfig.provider) {
    case 'jira':
    case 'linear': return /([A-Z]+-\d+)/i;
    case 'github': return /#?(\d+)/;
    default: return /([A-Z]+-\d+)/i;
  }
}

function getFetchTicketPrompt(ticketId, providerConfig) {
  if (!providerConfig) return null;
  switch (providerConfig.provider) {
    case 'jira': return 'Fetch Jira ticket ' + ticketId + ' using mcp__atlassian__jira_get_issue with issue_key "' + ticketId + '". Return the ticket summary, description, status, and acceptance criteria.';
    case 'linear': return 'Fetch Linear issue ' + ticketId + ' using mcp__linear__get_issue with id "' + ticketId + '". Return the issue title, description, status, and any labels or acceptance criteria.';
    case 'github': return 'Fetch GitHub issue ' + ticketId + ' by running: gh issue view ' + ticketId.replace(/^#/, '') + ' --json title,body,state,labels. Return the issue title, body, state, and labels.';
    case 'none': return null;
    default: return null;
  }
}

function getTransitionPrompt(ticketId, status, providerConfig) {
  if (!providerConfig) return null;
  switch (providerConfig.provider) {
    case 'jira': return 'Transition Jira ticket ' + ticketId + ' to "' + status + '" (idempotent). Use mcp__atlassian__jira_get_transitions to get available transitions for ' + ticketId + ', then use mcp__atlassian__jira_transition_issue to move it to "' + status + '". If already in that status, report success.';
    case 'linear': return 'Update Linear issue ' + ticketId + ' status to "' + status + '" using mcp__linear__save_issue with id "' + ticketId + '" and state "' + status + '". If already in that status, report success.';
    case 'github':
    case 'none': return null;
    default: return null;
  }
}

function getCreateTicketPrompt(description, providerConfig) {
  if (!providerConfig) return null;
  switch (providerConfig.provider) {
    case 'jira': return 'Create a Jira ticket from this description: "' + description + '"';
    case 'linear': return 'Create a Linear issue from this description: "' + description + '" using mcp__linear__save_issue with a clear title and the description as the body.';
    case 'github': return 'Create a GitHub issue from this description: "' + description + '" by running: gh issue create --title "<title>" --body "<body>"';
    case 'none': return null;
    default: return null;
  }
}

function getAllowedMcpTools(providerConfig) {
  if (!providerConfig) return [];
  switch (providerConfig.provider) {
    case 'jira': return ['mcp__atlassian__jira_get_issue', 'mcp__atlassian__jira_get_transitions', 'mcp__atlassian__jira_transition_issue'];
    case 'linear': return ['mcp__linear__get_issue', 'mcp__linear__save_issue', 'mcp__linear__list_issues'];
    case 'github':
    case 'none': return [];
    default: return [];
  }
}

function getCreateTicketAgentType(providerConfig) {
  if (!providerConfig) return 'general-purpose';
  switch (providerConfig.provider) {
    case 'jira': return 'jira-task-creator';
    case 'linear':
    case 'github': return 'general-purpose';
    case 'none': return null;
    default: return 'general-purpose';
  }
}

module.exports = {
  getProviderConfig, saveProviderConfig, getRemoteOriginUrl, normalizeRemoteUrl,
  ticketUrl, prefixTicketId, getTicketPattern,
  getFetchTicketPrompt, getTransitionPrompt, getCreateTicketPrompt,
  getAllowedMcpTools, getCreateTicketAgentType,
  VALID_PROVIDERS, PROVIDERS_FILE,
};
