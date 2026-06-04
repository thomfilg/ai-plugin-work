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

const https = require('node:https');

const STATUS_URL = 'https://www.githubstatus.com/api/v2/components.json';

/**
 * Default fetcher uses `https.get` and resolves the parsed JSON body.
 * @returns {Promise<object>}
 */
function defaultFetcher() {
  return new Promise((resolve, reject) => {
    const req = https.get(STATUS_URL, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(buf));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('githubstatus timeout')));
  });
}

/**
 * @param {{ fetcher?: Function }} [opts]
 * @returns {{ degraded: boolean } | Promise<{ degraded: boolean }>}
 */
function checkActionsStatus(opts) {
  const fetcher = (opts && opts.fetcher) || defaultFetcher;
  const payload = fetcher();
  if (payload && typeof payload.then === 'function') {
    return payload.then(parseDegraded).catch(() => ({ degraded: false }));
  }
  return parseDegraded(payload);
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
