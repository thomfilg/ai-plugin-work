/**
 * GitHub Actions status cross-check (R16).
 *
 * Queries https://www.githubstatus.com/api/v2/components.json and reports
 * whether the "Actions" component is currently degraded.
 *
 * Exposes `checkActionsStatus({ fetcher })` for testability — tests inject a
 * fake `fetcher` returning the parsed JSON.
 */

'use strict';

const { execFileSync } = require('node:child_process');

const STATUS_URL = 'https://www.githubstatus.com/api/v2/components.json';

/**
 * Default fetcher uses `curl` via execFileSync so the step (which runs
 * synchronously inside step-registry.runStep) can stay sync. Returns parsed
 * JSON or throws.
 *
 * @returns {object}
 */
function defaultFetcher() {
  const stdout = execFileSync(
    'curl',
    ['-fsS', '--max-time', '5', STATUS_URL],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 6000 }
  );
  return JSON.parse(stdout);
}

/**
 * Synchronously query githubstatus.com for the Actions component health.
 * Any error (network, parse, missing fetcher) is swallowed and reported as
 * `{ degraded: false }` so the caller can fall through to the normal retry
 * path rather than blocking.
 *
 * @param {{ fetcher?: Function }} [opts]
 * @returns {{ degraded: boolean }}
 */
function checkActionsStatus(opts) {
  const fetcher = (opts && opts.fetcher) || defaultFetcher;
  try {
    const payload = fetcher();
    return parseDegraded(payload);
  } catch (_err) {
    return { degraded: false };
  }
}

function parseDegraded(payload) {
  if (!payload || !Array.isArray(payload.components)) return { degraded: false };
  const actions = payload.components.find(
    (c) => c && typeof c.name === 'string' && /actions/i.test(c.name)
  );
  if (!actions) return { degraded: false };
  // Anything other than "operational" counts as degraded.
  const degraded = actions.status && actions.status !== 'operational';
  return { degraded: Boolean(degraded) };
}

module.exports = { checkActionsStatus };
