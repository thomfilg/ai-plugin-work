'use strict';

/**
 * hook-error-log.js — logs hook errors to a file instead of stderr.
 *
 * Implementation lives in the vendored factory port ./hookEntrypoint/logHookError.js
 * (source of truth: factories/hookEntrypoint/logHookError.js via scripts/sync-vendored.js).
 *
 * The port is re-instantiated whenever THIS module is (re)loaded so that a
 * fresh require of hook-error-log.js re-reads HOOK_ERROR_LOG and re-opens the
 * log fd — the exact reset semantics the inline implementation had.
 */

delete require.cache[require.resolve('./hookEntrypoint/logHookError')];
module.exports = require('./hookEntrypoint/logHookError');
