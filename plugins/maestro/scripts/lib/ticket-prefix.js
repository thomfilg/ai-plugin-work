'use strict';

/**
 * ticket-prefix.js — maestro-local, read-only provider lookup for
 * resolve-prefix.sh (WP-09, design §B/C10).
 *
 * Cache installs isolate each plugin in its own directory, so the old
 * `../../../work/scripts/workflows/lib/ticket-provider.js` sourcing crashes
 * there (the work plugin simply is not a sibling). This vendors JUST the
 * projectKey resolution the prefix needs — no prompting, no config writes,
 * no ticket parsing. Resolution mirrors ticket-provider.getProviderConfig():
 *
 *   TICKET_PROVIDER env → provider built from env keys
 *   → ~/.claude/ticket-providers.json entry keyed by the normalized git
 *     remote origin URL
 *   → JIRA_PROJECT_KEY legacy env
 *   → null (caller falls open to the "GH" prefix)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const VALID_PROVIDERS = new Set(['jira', 'linear', 'github', 'none']);

function providersFile() {
  const home = os.homedir() || process.env.HOME || '/home/node';
  return path.join(home, '.claude', 'ticket-providers.json');
}

/** Same normalization as ticket-provider.js so file keys keep matching. */
function normalizeRemoteUrl(url) {
  if (!url) return null;
  return url
    .replace(/^git@/, '')
    .replace(/^https?:\/\//, '')
    .replace(/:/, '/')
    .replace(/\.git$/, '')
    .toLowerCase();
}

function remoteKey(cwd) {
  try {
    const url = execSync('git remote get-url origin', {
      cwd: cwd || process.cwd(),
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return normalizeRemoteUrl(url);
  } catch {
    return null;
  }
}

function configFromEnv() {
  const provider = (process.env.TICKET_PROVIDER || '').toLowerCase();
  if (!VALID_PROVIDERS.has(provider)) return null;
  if (provider === 'none') return { provider };
  if (provider === 'github') return { provider, projectKey: '' };
  const projectKey = process.env.TICKET_PROJECT_KEY || process.env.JIRA_PROJECT_KEY || 'PROJ';
  return { provider, projectKey };
}

function configFromProvidersFile(cwd) {
  const key = remoteKey(cwd);
  if (!key) return null;
  try {
    const providers = JSON.parse(fs.readFileSync(providersFile(), 'utf-8'));
    return (providers && providers[key]) || null;
  } catch {
    return null;
  }
}

/**
 * Read-only equivalent of ticket-provider.getProviderConfig({skipPrompt:true}).
 * The `opts` bag is accepted for call-shape compatibility with the original
 * (resolve-prefix.sh passes {skipPrompt:true}); only `cwd` is consulted.
 */
function getProviderConfig(opts = {}) {
  const fromEnv = configFromEnv();
  if (fromEnv) return fromEnv;
  const fromFile = configFromProvidersFile(opts.cwd);
  if (fromFile) return fromFile;
  if (process.env.JIRA_PROJECT_KEY) {
    return { provider: 'jira', projectKey: process.env.JIRA_PROJECT_KEY };
  }
  return null;
}

module.exports = { getProviderConfig, normalizeRemoteUrl };
