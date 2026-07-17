// GENERATED — edit factories/runtime/run-hook.js and run scripts/sync-vendored.js

'use strict';

/**
 * run-hook.js — the runtime-aware hook entry wrapper (GH-774).
 *
 * `hookEntrypoint/runHook` pins the stdin → parse → guarded-handler → exit
 * protocol but knows nothing about the dual-runtime world: it does not detect
 * the runtime, does not resolve the hook event when the host omits the
 * `CLAUDE_HOOK_TYPE` env (codex sets none of the CLAUDE_* vars — ground truth
 * §2.7.2), and does not normalize the two runtimes' divergent payload shapes.
 * Under codex those gaps are the observed crashes: a Stop hook that reads the
 * event from env alone falls through to its CLI branch and exits 1
 * ("Stop hook failed: exited with code 1").
 *
 * `runHook(handler, opts)` closes those gaps in one place:
 *
 *  1. Stdin is drained defensively (TTY guard; a stream error resolves '').
 *  2. The payload is parsed with a never-throw JSON parse → `{}` on garbage.
 *  3. The runtime is detected from the RAW payload (getRuntime) before any
 *     field is read, so detection sees turn_id / rollout transcript markers.
 *  4. The event is resolved payload-first: opts.event → CLAUDE_HOOK_TYPE env →
 *     payload.hook_event_name → opts.defaultEvent. Never depends on the env
 *     alone, which codex does not set.
 *  5. The raw payload is normalized to the CanonicalHookEvent shape; missing
 *     or renamed fields DEGRADE to null/defaults and never throw.
 *  6. The handler is invoked with { rt, evt, event, raw } and may be sync or
 *     async. It may exit the process itself (the emit facet does); runHook's
 *     own exit is the fallthrough.
 *  7. A handler that resolves without exiting → exit 0.
 *  8. A handler that throws:
 *       - onError 'open' (default): logError(file, err) then exit 0 with
 *         NOTHING on stdout/stderr — the fail-open advisory contract.
 *       - onError 'closed': a NON-EMPTY line on stderr (padded) then exit 2,
 *         preserving intentional blocking semantics.
 *
 * `logError` is injectable so this module keeps the runtime factory's
 * zero-cross-vendor-dependency invariant; hook scripts pass their vendored
 * `logHookError`. When omitted, errors are swallowed (fail-open still holds).
 */

const { getRuntime } = require('./index');

const VALID_ON_ERROR = new Set(['open', 'closed']);
const CLOSED_FALLBACK = 'hook handler failed without an error message';

/**
 * Drain a readable stream to utf8; a stream error yields '' (never rejects).
 * Uses the async-iterator idiom deliberately: this factory is vendored to
 * maestro, which does NOT carry hookEntrypoint.js, so run-hook must stay
 * self-contained rather than reuse that module's event-handler collectStream.
 */
async function collectStream(stream) {
  stream.setEncoding('utf8');
  let data = '';
  try {
    for await (const chunk of stream) data += chunk;
  } catch {
    return '';
  }
  return data;
}

/**
 * Read the raw hook payload text from stdin. TTY guard: an interactive
 * invocation (nothing piped) resolves '' instead of hanging forever.
 */
async function readStdin(stdin = process.stdin) {
  if (stdin.isTTY) return '';
  return collectStream(stdin);
}

/** Parse a hook payload. Never throws — empty/garbage yields the fallback. */
function parsePayload(text, fallback = {}) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Resolve the hook event without depending on CLAUDE_HOOK_TYPE alone (codex
 * omits it): explicit opt → env → payload.hook_event_name → default.
 */
function resolveEvent(raw, opts, env) {
  const fromEnv = env.CLAUDE_HOOK_TYPE;
  const fromPayload = raw && typeof raw.hook_event_name === 'string' ? raw.hook_event_name : null;
  return opts.event || fromEnv || fromPayload || opts.defaultEvent || null;
}

function assertConfig(handler, opts) {
  if (typeof handler !== 'function') {
    throw new TypeError('runHook: missing "handler"');
  }
  const mode = opts.onError === undefined ? 'open' : opts.onError;
  if (!VALID_ON_ERROR.has(mode)) {
    throw new TypeError("runHook: \"onError\" must be 'open' or 'closed'");
  }
  return mode;
}

/** Extract a printable message from an arbitrary thrown value; never throws. */
function safeMessage(err) {
  try {
    const raw = err && err.message ? String(err.message) : '';
    return raw.trim() ? raw : '';
  } catch {
    return '';
  }
}

/**
 * Fail-closed exit: stderr MUST be non-empty or the block may not register on
 * some host runtimes (an empty stderr flips exit-2 back to fail-open).
 */
function exitClosed(err) {
  process.stderr.write(`${safeMessage(err) || CLOSED_FALLBACK}\n`);
  process.exit(2);
}

/** Fail-open exit: log (guarded) then exit 0 with silent stdout/stderr. */
function exitOpen(logError, file, err) {
  try {
    if (typeof logError === 'function') logError(file, err);
  } catch {
    /* logging must never break fail-open */
  }
  process.exit(0);
}

/** Build the { rt, evt, event, raw } context handed to a hook handler. */
function buildContext(raw, opts, env) {
  const rt = getRuntime(raw);
  const event = resolveEvent(raw, opts, env);
  const evt = rt.normalizeHookPayload(raw, event ? { event } : {});
  return { rt, evt, event, raw };
}

async function dispatch(handler, mode, opts, env) {
  const raw = parsePayload(await readStdin(opts.stdin));
  try {
    await handler(buildContext(raw, opts, env));
  } catch (err) {
    if (mode === 'closed') exitClosed(err);
    exitOpen(opts.logError, opts.file || 'runHook', err);
    return;
  }
  process.exit(0);
}

/**
 * Run a hook handler under the runtime-aware entry protocol.
 *
 * @param {(ctx: {rt: object, evt: object, event: string|null, raw: object}) => any} handler
 * @param {object} [opts]
 * @param {string} [opts.event] - Force the hook event (highest precedence).
 * @param {string} [opts.defaultEvent] - Event when nothing else resolves one.
 * @param {'open'|'closed'} [opts.onError] - Failure policy (default 'open').
 * @param {(file: string, err: unknown) => void} [opts.logError] - Error sink.
 * @param {string} [opts.file] - Source label for the error log.
 * @param {NodeJS.ReadStream} [opts.stdin] - Injectable stdin (tests).
 * @param {NodeJS.ProcessEnv} [opts.env] - Injectable env (tests).
 */
function runHook(handler, opts) {
  const options = opts || {};
  const mode = assertConfig(handler, options);
  const env = options.env || process.env;
  return dispatch(handler, mode, options, env);
}

module.exports = { runHook, readStdin, parsePayload, resolveEvent };
