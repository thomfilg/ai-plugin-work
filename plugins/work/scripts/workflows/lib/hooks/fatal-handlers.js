'use strict';

/**
 * Shared fatal-signal handlers for enforcement hooks.
 *
 * Every hook installs the same uncaughtException/unhandledRejection pair that
 * logs the error and exits 2 when the hook had already decided to block, else
 * 0 (fail-open). Inlining that identical block in each hook produced a jscpd
 * duplicate-block violation; this helper is the single source of truth.
 *
 * @param {string} filename - __filename of the calling hook (for the log).
 * @param {(filename: string, err: unknown) => void} logHookError - logger.
 * @param {() => boolean} getDidBlock - reads the hook's live block decision at
 *   crash time (a getter, not a snapshot, so a block decided before the throw
 *   is honored).
 */
function installFatalHandlers(filename, logHookError, getDidBlock) {
  const onFatal = (err) => {
    logHookError(filename, err);
    process.exit(getDidBlock() ? 2 : 0);
  };
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal);
}

module.exports = { installFatalHandlers };
