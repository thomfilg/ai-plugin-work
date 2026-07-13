'use strict';

/**
 * Single shared recall-provider resolver (GH-662).
 *
 * Both auto-recall entry points — the hook's Phase 2 inline recall
 * (`lib/cortex-hook.resolveInlineRecall`) and the detached Phase 1 worker
 * (`scripts/synapsys-cortex-recall-bg.resolveRecallFn`) — delegate here so the
 * provider precedence lives in exactly one place:
 *
 *   1. `SYNAPSYS_CORTEX_RECALL_MODULE` set → require it. A valid module (an
 *      exported `recall` function) wins outright. A set-but-broken module
 *      resolves to NO provider — the default bridge is NEVER used as a
 *      fallback for an explicitly configured module (an integrator who set the
 *      var gets their module or nothing, not silent different behavior).
 *   2. Env unset → the zero-config default bridge (`lib/cortex-bridge`), when
 *      `detect()` says a cortex sqlite db is readable on this Node.
 *   3. Otherwise → no provider (recall disabled), with the detect reason as
 *      the `source` for status surfaces.
 *
 * Fail-open throughout: resolution never throws.
 *
 * @module lib/cortex-provider
 */

const os = require('node:os');

const bridge = require('./cortex-bridge');

/**
 * Resolve the effective recall provider.
 *
 * @param {{ env?: object, home?: string }} [opts]
 * @returns {{ recall: Function|null, provider: 'module'|'bridge'|null, source: string }}
 *   `recall(query, projectId) → Array | Promise<Array>` or null when no
 *   provider resolves; `source` is the module path, the bridge db path, or a
 *   human-readable reason recall is disabled.
 */
function resolveRecall({ env = process.env, home } = {}) {
  const modPath = String(env.SYNAPSYS_CORTEX_RECALL_MODULE || '').trim();
  if (modPath) return resolveModule(modPath);

  const resolvedHome = home || env.HOME || os.homedir();
  const detection = bridge.detect({ home: resolvedHome, env });
  if (!detection.available) {
    return { recall: null, provider: null, source: detection.reason };
  }
  return {
    recall: (query, projectId) => bridge.recall(query, projectId, { home: resolvedHome, env }),
    provider: 'bridge',
    source: bridge.dbPath({ home: resolvedHome, env }),
  };
}

/**
 * Require an explicitly configured provider module. Unloadable or malformed
 * (no `recall` function) → no provider — never the bridge (explicit env wins).
 *
 * @param {string} modPath value of SYNAPSYS_CORTEX_RECALL_MODULE
 * @returns {{ recall: Function|null, provider: 'module'|null, source: string }}
 */
function resolveModule(modPath) {
  try {
    // Dynamic provider require — path comes from SYNAPSYS_CORTEX_RECALL_MODULE.
    const mod = require(modPath);
    if (mod && typeof mod.recall === 'function') {
      return { recall: mod.recall.bind(mod), provider: 'module', source: modPath };
    }
  } catch {
    // Fall through — a broken configured module disables recall (fail-open).
  }
  return { recall: null, provider: null, source: 'module-error' };
}

module.exports = { resolveRecall };
