'use strict';

/**
 * Shared CLI entry runner for `/stats` and `/health` (GH-317 / R10).
 *
 * Folds the identical `require.main === module` boilerplate into one place:
 * invoke `main(argv)`, default to exit code 1 on any throw (the contract: never
 * surface an uncaught stack trace), then `process.exit`.
 *
 * Zero runtime dependencies.
 */

/**
 * Run a script's `main`, swallow throws, and exit the process.
 *
 * @param {(argv: string[]) => number} main - the script entry point; receives
 *   `process.argv.slice(2)` and returns the intended exit code.
 * @returns {void} always calls `process.exit`.
 */
function runMain(main) {
  let code = 1;
  try {
    code = main(process.argv.slice(2));
  } catch (_err) {
    // Contract: never surface an uncaught stack trace.
    code = 1;
  }
  process.exit(code);
}

module.exports = { runMain };
