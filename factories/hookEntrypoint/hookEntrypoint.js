'use strict';

/**
 * hookEntrypoint — the canonical entry protocol for hook scripts:
 * read stdin → parse the JSON payload → run a guarded handler → always end
 * the process with a deliberate exit code.
 *
 * A hook process is judged by its exit code and its stderr bytes, not by a
 * return value, so the protocol *around* a handler matters as much as the
 * handler itself. `runHook(handler, opts)` pins that protocol down:
 *
 * - Stdin is read event-based with a TTY guard: an interactive invocation
 *   (nothing piped) reads as '', and a stream error also resolves to ''
 *   instead of throwing. The handler always receives a payload object.
 * - The payload is parsed with `parsePayload`, which returns its fallback
 *   (`{}` by default) for empty or malformed input and never throws — a
 *   hook must not die on the shape of its stdin.
 * - The handler runs inside try/catch and may be sync or async. Handlers
 *   are allowed to call `process.exit` themselves (dispatchers that emit a
 *   deny envelope do exactly that); runHook's own exit is the fallthrough.
 * - A handler that resolves without exiting → `process.exit(0)`.
 * - A handler that throws with `opts.onError` 'open' (the default) → the
 *   error goes to the file logger (`logHookError(opts.file, err)`) and the
 *   process exits 0 with NOTHING on stderr. The host runtime treats any
 *   stderr byte as a hook failure, so a fail-open hook must stay silent;
 *   this exit-0 contract is load-bearing enforcement surface. The log call
 *   itself is guarded — logging must never break fail-open (an unhandled
 *   rejection would print a stack to stderr and exit 1).
 * - A handler that throws with `opts.onError` 'closed' → a NON-EMPTY line
 *   on stderr (padded with a default when the error carries no message,
 *   because an empty stderr can flip an exit-2 hook back to fail-open on
 *   some host runtimes), then `process.exit(2)`.
 */

const { logHookError } = require('./logHookError');

/** Drain a readable stream into a utf8 string; a stream error resolves ''. */
function collectStream(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(chunks.join('')));
    stream.on('error', () => resolve(''));
  });
}

/**
 * Read the full hook payload text from stdin.
 *
 * TTY guard: when the script is run interactively (no piped payload) this
 * resolves '' immediately instead of hanging on a stdin that never ends.
 *
 * @returns {Promise<string>} raw stdin text; '' on TTY or stream error.
 */
async function readStdin() {
  if (process.stdin.isTTY) return '';
  return collectStream(process.stdin);
}

/**
 * Parse a hook payload. Never throws.
 *
 * @param {string} text - Raw stdin text.
 * @param {object} [fallback] - Returned for empty or malformed input.
 * @returns {object} the parsed payload, or `fallback`.
 */
function parsePayload(text, fallback = {}) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function assertRunHookConfig(handler, opts) {
  if (typeof handler !== 'function') {
    throw new TypeError('hookEntrypoint: missing "handler"');
  }
  const mode = opts.onError === undefined ? 'open' : opts.onError;
  if (mode !== 'open' && mode !== 'closed') {
    throw new TypeError("hookEntrypoint: \"onError\" must be 'open' or 'closed'");
  }
  return mode;
}

/** Fail-closed exit: stderr must be non-empty or the block may not register. */
function exitClosed(err) {
  let message = '';
  try {
    const raw = err && err.message ? String(err.message) : '';
    if (raw.trim()) message = raw;
  } catch {
    // Building the message threw (throwing getter, unstringable value) —
    // fall through to the fixed fallback line. An EMPTY stderr can flip an
    // exit-2 hook back to fail-open on some host runtimes, so a non-empty
    // write is mandatory here.
  }
  if (!message) message = 'hook handler failed without an error message';
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

async function dispatch(handler, mode, sourceFile) {
  const payload = parsePayload(await readStdin());
  try {
    await handler(payload);
  } catch (err) {
    if (mode === 'closed') exitClosed(err);
    try {
      // Logging must never break fail-open: if logHookError throws (exotic
      // error object, deleted cwd) the async dispatch promise would reject
      // unhandled — Node prints a stack to stderr and exits 1, the exact
      // failure the exit-0 contract exists to prevent.
      logHookError(sourceFile, err);
    } catch {
      /* swallow: fail-open means exit 0 with silent stderr, no matter what */
    }
    process.exit(0);
  }
  process.exit(0);
}

/**
 * Run a hook handler under the canonical entry protocol. Always ends the
 * process (see the decision matrix in the file header); the returned promise
 * only settles in the config-error case, which throws synchronously.
 *
 * @param {(payload: object) => any} handler - Sync or async payload handler.
 * @param {object} [opts]
 * @param {'open'|'closed'} [opts.onError] - Failure policy (default 'open').
 * @param {string} [opts.file] - Source label for the error log; pass
 *   `__filename` from the hook script. Defaults to 'hookEntrypoint'.
 */
function runHook(handler, opts) {
  const options = opts || {};
  const mode = assertRunHookConfig(handler, options);
  return dispatch(handler, mode, options.file || 'hookEntrypoint');
}

module.exports = { readStdin, parsePayload, runHook };
