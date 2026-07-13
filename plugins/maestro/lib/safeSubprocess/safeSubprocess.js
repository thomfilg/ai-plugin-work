// GENERATED — edit factories/safeSubprocess/safeSubprocess.js and run scripts/sync-vendored.js

'use strict';

/**
 * safeSubprocess — synchronous subprocess wrappers that make timeouts
 * non-optional and shell interpolation impossible.
 *
 * A synchronous child-process call with no deadline can freeze the entire
 * event loop of whatever host invoked it. These wrappers exist so a call
 * site can never *silently* opt out of a deadline: every invocation either
 * runs under a positive finite timeout (default 15000 ms) or carries an
 * explicit, human-readable justification for running without one.
 *
 * Decision matrix, in prose:
 *
 * - `command` must be a non-empty string, `args` an array of strings, and
 *   `opts` a plain object; anything else throws a TypeError immediately.
 * - When `opts.timeout` is absent, the default of 15000 ms is applied.
 * - When `opts.timeout` is a positive integer, it is used as-is.
 * - When `opts.timeout` is anything else — null, 0, a negative number,
 *   NaN, Infinity, a non-integer like 15.5 or 5e-324 (which Node itself
 *   would only reject later with a less actionable RangeError), or a
 *   non-number — the call throws a TypeError. There is no value that
 *   means "no timeout".
 * - The only way to run without a deadline is `opts.noTimeout` set to a
 *   non-empty justification string; the timeout key is then omitted from
 *   the final options entirely. A `noTimeout` that is not a non-empty
 *   string throws a TypeError.
 * - `opts.shell` is always stripped and replaced with `shell: false`;
 *   arguments are passed positionally and shell metacharacters stay
 *   literal. There is no opt-out.
 * - Every other option (`cwd`, `encoding`, `env`, `input`, `stdio`, ...)
 *   passes through untouched.
 *
 * The two exports differ only in failure semantics, mirroring their
 * `node:child_process` counterparts:
 *
 * - `safeSpawnSync` returns the raw `spawnSync` result object. It never
 *   throws for runtime failures (nonzero exit, missing binary, timeout) —
 *   callers keep their own success predicates over `status` / `stdout` /
 *   `signal` / `error`.
 * - `safeExecFileSync` returns `execFileSync`'s return value and throws
 *   on any failure, exactly like the native call.
 */

const { execFileSync, spawnSync } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 15000;

function assertCommand(command) {
  if (typeof command === 'string' && command.length > 0) return;
  throw new TypeError('safeSubprocess: command must be a non-empty string');
}

function assertArgs(args) {
  const ok = Array.isArray(args) && args.every((arg) => typeof arg === 'string');
  if (!ok) throw new TypeError('safeSubprocess: args must be an array of strings');
}

function assertOpts(opts) {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new TypeError('safeSubprocess: opts must be an object');
  }
}

/**
 * Resolve the effective timeout for a call, or `undefined` when the caller
 * supplied a valid `noTimeout` justification. Throws on every shape that
 * would disable the deadline without saying why.
 */
function resolveTimeout(opts) {
  if (opts.noTimeout !== undefined) {
    if (typeof opts.noTimeout !== 'string' || opts.noTimeout.trim().length === 0) {
      throw new TypeError('safeSubprocess: "noTimeout" must be a non-empty justification string');
    }
    return undefined;
  }
  const timeout = opts.timeout === undefined ? DEFAULT_TIMEOUT_MS : opts.timeout;
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new TypeError(
      'safeSubprocess: "timeout" must be a positive integer number of milliseconds; ' +
        'pass { noTimeout: "<justification>" } to run without a deadline'
    );
  }
  return timeout;
}

/** Build the options object actually handed to child_process. */
function buildFinalOpts(opts) {
  const timeout = resolveTimeout(opts);
  const final = { ...opts, shell: false };
  delete final.noTimeout;
  delete final.timeout;
  if (timeout !== undefined) final.timeout = timeout;
  return final;
}

function invoke(runner, command, args, opts) {
  assertCommand(command);
  assertArgs(args);
  assertOpts(opts);
  return runner(command, args, buildFinalOpts(opts));
}

/**
 * `spawnSync` under the timeout policy above. Returns the raw result
 * object — status, stdout, stderr, signal, error — untouched, so callers
 * keep their own success predicates (e.g. `r.status === 0 && r.stdout`).
 */
function safeSpawnSync(command, args = [], opts = {}) {
  return invoke(spawnSync, command, args, opts);
}

/**
 * `execFileSync` under the timeout policy above. Native semantics:
 * returns stdout on success, throws on nonzero exit / signal / timeout.
 */
function safeExecFileSync(command, args = [], opts = {}) {
  return invoke(execFileSync, command, args, opts);
}

module.exports = { safeSpawnSync, safeExecFileSync };
