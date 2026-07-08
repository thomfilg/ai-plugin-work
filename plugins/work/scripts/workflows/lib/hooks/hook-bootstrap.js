'use strict';

/**
 * Shared bootstrap for PreToolUse Bash hooks in this directory.
 *
 * Extracts the boilerplate every hook repeats:
 *   - fail-open process-level error handlers (unexpected errors must never
 *     block unrelated commands — log and exit 0)
 *   - plugin-root resolution via the env-honouring helper with the legacy
 *     path.resolve chain as the last-resort fallback
 *   - the main() runner with the same fail-open catch
 */

const path = require('path');
const { logHookError } = require(path.join(__dirname, '..', 'hook-error-log'));
const { resolvePluginRootHonouringEnv } = require('../../work/lib/resolve-plugin-root');

/**
 * Fail-open: unexpected errors should never block unrelated commands.
 * @param {string} hookFilename - the hook's own __filename (for error logs)
 */
function installFailOpenHandlers(hookFilename) {
  for (const event of ['uncaughtException', 'unhandledRejection']) {
    process.on(event, (err) => {
      logHookError(hookFilename, err);
      process.exit(0);
    });
  }
}

/**
 * Resolve the plugin-scripts root for a hook. Uses the shared env-honouring
 * helper; falls back to the literal `levelsUp`-deep path.resolve chain only
 * when the helper cannot find a plugin root (unrecognized install layout).
 *
 * @param {string} hookDirname - the hook's own __dirname
 * @param {number} levelsUp - directory levels from the hook to the root
 * @returns {string}
 */
function resolveHookPluginRoot(hookDirname, levelsUp) {
  return (
    resolvePluginRootHonouringEnv(hookDirname, levelsUp) ||
    path.resolve(hookDirname, ...new Array(levelsUp).fill('..'))
  );
}

/**
 * Run a hook's async main() with the standard fail-open catch.
 * @param {() => Promise<void>} main
 * @param {string} hookFilename - the hook's own __filename (for error logs)
 */
function runHookMain(main, hookFilename) {
  main().catch((err) => {
    logHookError(hookFilename, err);
    process.exit(0);
  });
}

module.exports = { installFailOpenHandlers, resolveHookPluginRoot, runHookMain };
