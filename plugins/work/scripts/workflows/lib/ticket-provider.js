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
 *
 * The remote-URL key normalization lives in the vendored runtime lib
 * (./runtime/tickets) so maestro's ticket-prefix.js reads back the exact keys
 * this module writes (byte-parity contract, no cross-plugin requires).
 * Provider-specific prompt builders live in ./ticket-provider-prompts and are
 * re-exported here so callers keep a single require surface.
 */
const fs = require('fs');
const path = require('path');

const os = require('os');

const { normalizeRemoteUrl, remoteOriginKey } = require('./runtime/tickets');
const {
  getFetchTicketPrompt,
  getRelatedTicketsPrompt,
  getTransitionPrompt,
  getCreateTicketPrompt,
  getAllowedMcpTools,
  getCreateTicketAgentType,
} = require('./ticket-provider-prompts');

const HOME_DIR = os.homedir() || process.env.HOME || '/home/node';
const CLAUDE_DIR = path.join(HOME_DIR, '.cl' + 'aude');
const PROVIDERS_FILE = path.join(CLAUDE_DIR, 'ticket-providers.json');
const VALID_PROVIDERS = ['jira', 'linear', 'github', 'none'];

function getRemoteOriginUrl(cwd = process.cwd()) {
  return remoteOriginKey(cwd);
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

/** Validated { ticketBase, suffix, separator } once a suffix form is matched. */
function parsedSuffix(ticketBase, suffix, separator) {
  if (!suffix || !/^[a-zA-Z0-9_-]+$/.test(suffix)) {
    throw new Error(
      `invalid suffix "${suffix}". Must match /^[a-zA-Z0-9_-]+$/ (alphanumeric, hyphens, underscores only, no nested paths).`
    );
  }
  return { ticketBase, suffix, separator };
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
  if (hyphenMatch) return parsedSuffix(hyphenMatch[1], hyphenMatch[2], '-');
  // Slash suffix: PROJ-123/phase1
  const slashIdx = raw.indexOf('/');
  if (slashIdx === -1) return { ticketBase: raw, suffix: null };
  const ticketBase = raw.substring(0, slashIdx);
  const looksLikeTicket = /^[A-Z]+-\d+$/i.test(ticketBase) || /^#\d+$/.test(ticketBase);
  if (!looksLikeTicket) return { ticketBase: raw, suffix: null };
  return parsedSuffix(ticketBase, raw.substring(slashIdx + 1), '/');
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

/** Reject null/undefined/empty and non-string raw ticket arguments. */
function assertRawTicketString(raw) {
  if (raw === null || raw === undefined || raw === '') {
    throw new Error('Ticket ID is required.');
  }
  if (typeof raw !== 'string') {
    throw new Error(`Ticket ID must be a string (received ${typeof raw}).`);
  }
}

/** URL-form validation: only GitHub issue URLs are recognized. */
function validateTicketUrl(raw) {
  const parsed = parseGitHubUrl(raw);
  if (!parsed) {
    throw new Error(`Unrecognized ticket URL: ${raw}`);
  }
  const canonical = 'GH-' + parsed.number;
  return { ticketBase: canonical, suffix: null, separator: null, canonical };
}

/**
 * Path-safety subset shared with the structured validator (covers ../,
 * backslash, colon, NUL, leading slash, multi-slash, leading/trailing
 * whitespace, bare dot). It does NOT reject internal whitespace, so that is
 * checked explicitly here.
 */
function assertTicketPathSafe(raw) {
  let structErr = null;
  try {
    const { validateTicketIdStructured } = require('./ticket-validation');
    structErr = validateTicketIdStructured(raw);
  } catch (e) {
    if (!e || e.code !== 'MODULE_NOT_FOUND') throw e;
  }
  if (structErr) {
    const err = new Error(structErr.message);
    err.code = structErr.code;
    err.remediation = structErr.remediation;
    throw err;
  }
  if (/\s/.test(raw)) {
    throw new Error(
      `Ticket ID ${JSON.stringify(raw)} contains whitespace. Expected format: PROJ-123 or PROJ-123-suffix (no spaces).`
    );
  }
}

/** Provider-aware base format check: #N / N / GH-N on GitHub, PROJ-123 elsewhere. */
function assertTicketBaseFormat(ticketBase, isGitHub) {
  const baseOk = isGitHub
    ? /^#?\d+$/.test(ticketBase) || /^GH-\d+$/i.test(ticketBase)
    : /^[A-Z]+-\d+$/i.test(ticketBase);
  if (baseOk) return;
  const expected = isGitHub ? '#N, N, or GH-N' : 'PROJ-123';
  throw new Error(
    `Invalid ticket ID base ${JSON.stringify(ticketBase)} — expected ${expected} format.`
  );
}

/**
 * Strict validator for raw ticket arguments at the entry points of /work and
 * /work-implement. Rejects malformed input BEFORE any filesystem side effects.
 *
 * Returns { ticketBase, suffix, separator, canonical }. Throws Error on invalid.
 * `canonical` is the post-normalization handle used as the session identity.
 */
function validateRawTicketInput(raw, providerConfig) {
  assertRawTicketString(raw);
  // URL form: handle BEFORE the structured validator (URLs contain ':' which would
  // otherwise trip the unsafe-char check).
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return validateTicketUrl(raw);
  }
  assertTicketPathSafe(raw);
  const parsed = parseTicketInput(raw);
  const isGitHub = providerConfig && providerConfig.provider === 'github';
  assertTicketBaseFormat(parsed.ticketBase, isGitHub);
  return {
    ticketBase: String(parsed.ticketBase).toUpperCase(),
    suffix: parsed.suffix || null,
    separator: parsed.separator || null,
    canonical: normalizeTicketId(raw),
  };
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
  validateRawTicketInput,
  VALID_PROVIDERS,
  PROVIDERS_FILE,
};
