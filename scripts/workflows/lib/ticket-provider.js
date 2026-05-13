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

const os = require('os');

const HOME_DIR = os.homedir() || process.env.HOME || '/home/node';
const CLAUDE_DIR = path.join(HOME_DIR, '.cl' + 'aude');
const PROVIDERS_FILE = path.join(CLAUDE_DIR, 'ticket-providers.json');
const VALID_PROVIDERS = ['jira', 'linear', 'github', 'none'];

function getRemoteOriginUrl(cwd = process.cwd()) {
  try {
    const url = execSync('git remote get-url origin', {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return normalizeRemoteUrl(url);
  } catch {
    return null;
  }
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
    case 'jira':
      return {
        provider: 'jira',
        projectKey,
        baseUrl: process.env.JIRA_BASE_URL || 'your-org.atlassian.net',
      };
    case 'linear':
      return { provider: 'linear', projectKey, teamId: process.env.LINEAR_TEAM_ID || '' };
    case 'github':
      return { provider: 'github', projectKey: '' };
    case 'none':
      return { provider: 'none' };
    default:
      return null;
  }
}

/**
 * Parse a GitHub issue URL into its components.
 * Accepts: https://github.com/org/repo/issues/56, github.com/org/repo/issues/42
 * Returns { number, owner, repo } or null.
 */
function parseGitHubUrl(input) {
  if (!input) return null;
  const match = String(input).match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/i
  );
  if (!match) return null;
  return { number: match[3], owner: match[1], repo: match[2] };
}

/**
 * Convert a ticket ID into a file-system / branch-safe string.
 * GitHub: #56 or 56 → GH-56.  Others: returned as-is.
 */
function sanitizeTicketIdForPath(ticketId, providerConfig) {
  if (!ticketId) return ticketId; // null/undefined/empty guard
  if (!providerConfig || providerConfig.provider !== 'github') return ticketId;
  const str = String(ticketId);
  // Already sanitized (idempotent)
  if (/^GH-\d+$/i.test(str)) return str.toUpperCase();
  // Accept #N or plain number only — reject anything else
  if (/^#?\d+$/.test(str)) return 'GH-' + str.replace(/^#/, '');
  // Try extracting from a GitHub URL
  const parsed = parseGitHubUrl(str);
  if (parsed) return 'GH-' + parsed.number;
  // Unknown format — return as-is to avoid creating invalid paths
  return ticketId;
}

/**
 * Parse ticket input with optional suffix/phase syntax.
 * "JUL-1397-bugfix" → { ticketBase: "JUL-1397", suffix: "bugfix", separator: "-" }
 * "GH-145/phase1"  → { ticketBase: "GH-145",   suffix: "phase1", separator: "/" }
 * Plain IDs return suffix: null.
 */
function parseTicketInput(raw) {
  if (!raw || typeof raw !== 'string') return { ticketBase: raw, suffix: null };
  if (raw.startsWith('http://') || raw.startsWith('https://'))
    return { ticketBase: raw, suffix: null };
  // Hyphenated suffix: PROJ-123-suffix
  const hyphenMatch = raw.match(/^([A-Z]+-\d+)-(.+)$/i);
  if (hyphenMatch) {
    const suffix = hyphenMatch[2];
    if (!suffix || !/^[a-zA-Z0-9_-]+$/.test(suffix)) {
      throw new Error(
        `invalid suffix "${suffix}". Must match /^[a-zA-Z0-9_-]+$/ (alphanumeric, hyphens, underscores only, no nested paths).`
      );
    }
    return { ticketBase: hyphenMatch[1], suffix, separator: '-' };
  }
  // Slash suffix: PROJ-123/phase1
  const slashIdx = raw.indexOf('/');
  if (slashIdx === -1) return { ticketBase: raw, suffix: null };
  const ticketBase = raw.substring(0, slashIdx);
  const suffix = raw.substring(slashIdx + 1);
  const looksLikeTicket = /^[A-Z]+-\d+$/i.test(ticketBase) || /^#\d+$/.test(ticketBase);
  if (!looksLikeTicket) return { ticketBase: raw, suffix: null };
  if (!suffix || !/^[a-zA-Z0-9_-]+$/.test(suffix)) {
    throw new Error(
      `invalid suffix "${suffix}". Must match /^[a-zA-Z0-9_-]+$/ (alphanumeric, hyphens, underscores only, no nested paths).`
    );
  }
  return { ticketBase, suffix, separator: '/' };
}

/**
 * Normalize a ticket ID: uppercase only the base, preserve suffix case.
 * "jul-1397-bugfix" → "JUL-1397-bugfix"
 * "proj-123/phase1" → "PROJ-123/phase1"
 * "PROJ-123"        → "PROJ-123"
 */
function normalizeTicketId(raw) {
  const parsed = parseTicketInput(raw);
  const base = parsed.ticketBase
    ? String(parsed.ticketBase).toUpperCase()
    : String(raw).toUpperCase();
  if (!parsed.suffix) return base;
  return base + parsed.separator + parsed.suffix;
}

function ticketUrl(ticketId, providerConfig) {
  if (!providerConfig || !ticketId) return null;
  const num = String(ticketId).replace(/^#|^GH-/i, '');
  switch (providerConfig.provider) {
    case 'jira':
      return 'https://' + providerConfig.baseUrl + '/browse/' + ticketId;
    case 'linear':
      return 'https://linear.app/issue/' + ticketId;
    case 'github':
      if (providerConfig.owner && providerConfig.repo) {
        return (
          'https://github.com/' +
          providerConfig.owner +
          '/' +
          providerConfig.repo +
          '/issues/' +
          num
        );
      }
      return '#' + num;
    default:
      return null;
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
    default:
      return input;
  }
}

function getTicketPattern(providerConfig) {
  if (!providerConfig) return /([A-Z]+-\d+)/i;
  switch (providerConfig.provider) {
    case 'jira':
    case 'linear':
      return /([A-Z]+-\d+)/i;
    case 'github':
      return /#?(\d+)/;
    default:
      return /([A-Z]+-\d+)/i;
  }
}

function getFetchTicketPrompt(ticketId, providerConfig) {
  if (!providerConfig) return null;
  switch (providerConfig.provider) {
    case 'jira':
      return (
        'Fetch Jira ticket ' +
        ticketId +
        ' using mcp__atlassian__jira_get_issue with issue_key "' +
        ticketId +
        '". Return the ticket summary, description, status, and acceptance criteria.'
      );
    case 'linear':
      return (
        'Fetch Linear issue ' +
        ticketId +
        ' using mcp__linear__get_issue with id "' +
        ticketId +
        '". Return the issue title, description, status, and any labels or acceptance criteria.'
      );
    case 'github':
      return (
        'Fetch GitHub issue ' +
        ticketId +
        ' by running: gh issue view ' +
        ticketId.replace(/^#/, '') +
        ' --json title,body,state,labels. Return the issue title, body, state, and labels.'
      );
    case 'none':
      return null;
    default:
      return null;
  }
}

function getRelatedTicketsPrompt(ticketId, providerConfig, manifestPath) {
  if (!providerConfig) return null;
  const schemaBlock =
    'Schema (write this exact shape; arrays may be empty but must exist):\n' +
    '{\n' +
    '  "self":      { "id": "' +
    ticketId +
    '", "title": "...", "status": "..." },\n' +
    '  "parent":    { "id": "...", "title": "...", "status": "...", "scope": "..." } | null,\n' +
    '  "siblings":  [ { "id": "...", "title": "...", "status": "...", "scope": "...", "prNumber": 1234, "surfaces": ["lib/x.ts", "app/api/.../y.ts"] } ],\n' +
    '  "blockedBy": [ { "id": "...", "title": "...", "status": "...", "scope": "...", "prNumber": null } ],\n' +
    '  "dependsOn": [ { "id": "...", "title": "...", "status": "...", "scope": "...", "prNumber": null } ],\n' +
    '  "relatedTo": [ { "id": "...", "title": "...", "status": "...", "scope": "...", "prNumber": null } ],\n' +
    '  "fetchedAt": "<ISO-8601 timestamp NOW>"\n' +
    '}\n' +
    '\n' +
    'Rules:\n' +
    '- `parent` is null when this ticket has no parent. Otherwise populate from the parent link.\n' +
    '- `siblings` = children of the same parent, EXCLUDING this ticket. If there is no parent, leave it [].\n' +
    '- `blockedBy` / `dependsOn` / `relatedTo` come from the ticket-system link types.\n' +
    "- **`scope` (REQUIRED on every linked entry):** read each linked ticket's full description, then distill it into a focused one-to-three-sentence summary of WHAT THAT TICKET OWNS — files, endpoints, schemas, layers. This is the field downstream agents use to decide sibling ownership when no PR is merged yet.\n" +
    '  - Good: `"scope": "Owns the new `externalAssets.listDownstreamDashboards` tRPC procedure on viewsRouter and its Zod schema. Adds `select`+`where` for Dashboard rows. No UI changes."`\n' +
    '  - Bad (too vague): `"scope": "Backend work for downstream dashboards"`\n' +
    '  - Bad (full body): pasting the entire ticket description verbatim.\n' +
    '  - Bad (too narrow): `"scope": "Wire to explore.list"` without naming any concrete surface.\n' +
    '  - Keep `scope` ≤ ~400 characters. Strip implementation noise (deadlines, status updates, side-comments) — keep only ownership signals.\n' +
    '- For every sibling AND parent with a merged PR, populate `surfaces` with the list of files changed in that PR (run `gh pr diff <N> --name-only` and copy the file paths). For unshipped tickets, leave `surfaces: []` — `scope` is what carries ownership info in that case.\n' +
    '- Write the JSON to: ' +
    manifestPath +
    '\n' +
    '- After writing, validate by reading it back and parsing.';
  switch (providerConfig.provider) {
    case 'jira':
      return (
        'Fetch related tickets for Jira issue ' +
        ticketId +
        ' and write a related-tickets manifest.\n\n' +
        'Steps:\n' +
        '1. Use mcp__atlassian__jira_get_issue with issue_key "' +
        ticketId +
        '" and fetch the full payload including the `issuelinks` field and the `parent` field.\n' +
        '2. Parse:\n' +
        '   - `parent`: from fields.parent if present.\n' +
        '   - `siblings`: search for siblings via JQL `parent = "' +
        ticketId +
        '"`\'s parent — use mcp__atlassian__jira_search with JQL `parent = "<parent-key>"` and exclude ' +
        ticketId +
        '.\n' +
        '   - `blockedBy`: issuelinks where this issue `is blocked by`.\n' +
        '   - `dependsOn`: issuelinks where this issue `depends on`.\n' +
        '   - `relatedTo`: issuelinks where the link type is `relates to`.\n' +
        "3. For each linked ticket with a merged PR, find the PR number from the issue's remote links or development field, then run `gh pr diff <N> --name-only` to populate `surfaces`.\n\n" +
        schemaBlock
      );
    case 'linear':
      return (
        'Fetch related issues for Linear issue ' +
        ticketId +
        ' and write a related-tickets manifest.\n\n' +
        'Steps:\n' +
        '1. Use mcp__linear__get_issue with id "' +
        ticketId +
        '" and capture: `parent`, `children`, and `relations` (each relation has a `type`: `blocks`, `blocked_by`, `duplicate`, `related`, …).\n' +
        '2. Parse:\n' +
        '   - `parent`: from the parent field.\n' +
        '   - `siblings`: if there is a parent, list its other children (use mcp__linear__get_issue on the parent and read `children`, exclude ' +
        ticketId +
        ').\n' +
        '   - `blockedBy`: relations where type is `blocked_by` (or the inverse of `blocks`).\n' +
        "   - `dependsOn`: relations where type is `blocks` and the target depends on this issue — use the same field interpreted per Linear's schema.\n" +
        '   - `relatedTo`: relations where type is `related`.\n' +
        '3. For each linked issue with a merged PR (Linear surfaces these via the `attachments` or external links), run `gh pr diff <N> --name-only` to populate `surfaces`.\n\n' +
        schemaBlock
      );
    case 'github':
      return (
        'Fetch related issues for GitHub issue ' +
        ticketId +
        ' and write a related-tickets manifest.\n\n' +
        'Steps:\n' +
        '1. Run `gh issue view ' +
        ticketId.replace(/^#/, '') +
        ' --json title,body,labels,milestone` and capture the body.\n' +
        '2. Parse the body for these conventions (case-insensitive):\n' +
        '   - `Parent: #N` or `Parent issue: #N` → `parent`.\n' +
        '   - `Blocked by: #N, #M` → each goes into `blockedBy`.\n' +
        '   - `Depends on: #N` → `dependsOn`.\n' +
        '   - `Related: #N` or `Related to: #N` → `relatedTo`.\n' +
        '3. For siblings: if there is a parent, run `gh issue view <parent-N> --json body` and parse its body for a checklist of sub-issues (`- [ ] #N`, `- [x] #N`), excluding ' +
        ticketId +
        '.\n' +
        '4. For each linked issue, run `gh issue view <N> --json state,title` to populate status, and `gh pr list --search "linked-issue:<N>" --state merged --json number` to find the merged PR. If a PR exists, run `gh pr diff <N> --name-only` to populate `surfaces`.\n\n' +
        schemaBlock
      );
    case 'none':
      return null;
    default:
      return null;
  }
}

function getTransitionPrompt(ticketId, status, providerConfig) {
  if (!providerConfig) return null;
  switch (providerConfig.provider) {
    case 'jira':
      return (
        'Transition Jira ticket ' +
        ticketId +
        ' to "' +
        status +
        '" (idempotent). Use mcp__atlassian__jira_get_transitions to get available transitions for ' +
        ticketId +
        ', then use mcp__atlassian__jira_transition_issue to move it to "' +
        status +
        '". If already in that status, report success.'
      );
    case 'linear':
      return (
        'Update Linear issue ' +
        ticketId +
        ' status to "' +
        status +
        '" using mcp__linear__save_issue with id "' +
        ticketId +
        '" and state "' +
        status +
        '". If already in that status, report success.'
      );
    case 'github':
    case 'none':
      return null;
    default:
      return null;
  }
}

function getCreateTicketPrompt(description, providerConfig) {
  if (!providerConfig) return null;
  switch (providerConfig.provider) {
    case 'jira':
      return 'Create a Jira ticket from this description: "' + description + '"';
    case 'linear':
      return (
        'Create a Linear issue from this description: "' +
        description +
        '" using mcp__linear__save_issue with a clear title and the description as the body.'
      );
    case 'github':
      return (
        'Create a GitHub issue from this description: "' +
        description +
        '" by running: gh issue create --title "<title>" --body "<body>"'
      );
    case 'none':
      return null;
    default:
      return null;
  }
}

function getAllowedMcpTools(providerConfig) {
  if (!providerConfig) return [];
  switch (providerConfig.provider) {
    case 'jira':
      return [
        'mcp__atlassian__jira_get_issue',
        'mcp__atlassian__jira_get_transitions',
        'mcp__atlassian__jira_transition_issue',
      ];
    case 'linear':
      return ['mcp__linear__get_issue', 'mcp__linear__save_issue', 'mcp__linear__list_issues'];
    case 'github':
    case 'none':
      return [];
    default:
      return [];
  }
}

function getCreateTicketAgentType(providerConfig) {
  if (!providerConfig) return 'general-purpose';
  switch (providerConfig.provider) {
    case 'jira':
      return 'jira-task-creator';
    case 'linear':
    case 'github':
      return 'general-purpose';
    case 'none':
      return null;
    default:
      return 'general-purpose';
  }
}

module.exports = {
  getProviderConfig,
  saveProviderConfig,
  getRemoteOriginUrl,
  normalizeRemoteUrl,
  ticketUrl,
  prefixTicketId,
  getTicketPattern,
  getFetchTicketPrompt,
  getRelatedTicketsPrompt,
  getTransitionPrompt,
  getCreateTicketPrompt,
  getAllowedMcpTools,
  getCreateTicketAgentType,
  parseGitHubUrl,
  sanitizeTicketIdForPath,
  parseTicketInput,
  normalizeTicketId,
  VALID_PROVIDERS,
  PROVIDERS_FILE,
};
