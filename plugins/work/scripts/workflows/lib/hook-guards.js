/**
 * hook-guards.js
 *
 * Shared process-level guards and the optional-config loader used by hook
 * entry scripts. Extracted from the per-hook copies (work-enforce-steps,
 * enforce-coverage-fix, work-require-implement lineage) so each hook carries
 * a one-line call instead of the same boilerplate block.
 */

const { logHookError } = require('./hook-error-log');

/**
 * Register uncaughtException/unhandledRejection handlers that log the error
 * via logHookError and exit with the code produced by `exitCode()`.
 *
 * Fail-open hooks use the default (always 0). Block-aware hooks pass a
 * callback reading their `didBlock` flag, e.g. `() => (didBlock ? 2 : 0)`.
 *
 * @param {string} filename — the hook's __filename (attributed in the log)
 * @param {() => number} [exitCode]
 */
function installProcessGuards(filename, exitCode = () => 0) {
  for (const event of ['uncaughtException', 'unhandledRejection']) {
    process.on(event, (err) => {
      logHookError(filename, err);
      process.exit(exitCode());
    });
  }
}

/**
 * Load workflows/lib/config for hooks that must fail open when the module
 * itself is missing (standalone copies of a hook without the lib tree),
 * while still surfacing unrelated require errors — a MODULE_NOT_FOUND
 * raised by one of config's own transitive requires is rethrown.
 *
 * @returns {object|null} the config module, or null when absent
 */
function loadConfigOrNull() {
  try {
    return require('./config');
  } catch (err) {
    const missingConfigItself =
      err && err.code === 'MODULE_NOT_FOUND' && /['"]\.\/config['"]/.test(err.message);
    if (missingConfigItself) return null;
    throw err;
  }
}

module.exports = { installProcessGuards, loadConfigOrNull };
