'use strict';

/**
 * tickets.js — shared ticket-provider key helpers.
 *
 * `~/.claude/ticket-providers.json` is keyed by the normalized git remote
 * origin URL. The work plugin (ticket-provider.js) WRITES entries under that
 * key and the maestro plugin (ticket-prefix.js) READS them back, so the
 * normalization must stay byte-compatible across plugins. Cross-plugin
 * requires are forbidden (codex cache-isolates each plugin, INV P7), which is
 * why this lives in the vendored runtime lib instead of one plugin importing
 * the other.
 */

const { execSync } = require('node:child_process');

/**
 * Normalize a git remote URL into the providers-file key:
 * `git@github.com:Org/Repo.git` / `https://github.com/Org/Repo.git`
 * → `github.com/org/repo`. Falsy input ⇒ null.
 */
function normalizeRemoteUrl(url) {
  if (!url) return null;
  return url
    .replace(/^git@/, '')
    .replace(/^https?:\/\//, '')
    .replace(/:/, '/')
    .replace(/\.git$/, '')
    .toLowerCase();
}

/**
 * Normalized `git remote get-url origin` key for `cwd` (default:
 * process.cwd()). Returns null when git fails, times out, or there is no
 * origin remote — callers fall through to their next resolution leg.
 */
function remoteOriginKey(cwd) {
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

module.exports = { normalizeRemoteUrl, remoteOriginKey };
