# hookEntrypoint

The canonical entry protocol for hook scripts: read stdin → parse the JSON
payload → run a guarded handler → always end the process with a deliberate
exit code. Ships with `logHookError`, a production-grade file error logger,
because the fail-open half of the protocol is meaningless without somewhere
silent to put the error.

A hook process is judged by its exit code and its stderr bytes. The host
runtime treats **any** stderr output as a hook failure, and (on some host
runtimes) an exit-2 hook with **empty** stderr flips back to fail-open. The
protocol around the handler is therefore load-bearing enforcement surface —
this factory makes it impossible to get wrong per-hook.

## Decision matrix

`runHook(handler, opts)`:

| # | Condition | Behavior |
|---|---|---|
| 1 | stdin is a TTY (nothing piped) or the stream errors | handler receives `{}` |
| 2 | stdin empty or malformed JSON | handler receives `{}` |
| 3 | handler resolves without exiting | `process.exit(0)` |
| 4 | handler calls `process.exit` itself | that exit wins — runHook's exit is the fallthrough |
| 5 | handler throws, `onError: 'open'` (default) | `logHookError(opts.file, err)`; `process.exit(0)`; **nothing** on stderr |
| 6 | handler throws, `onError: 'closed'` | non-empty stderr line (padded with a default when the error has no message); `process.exit(2)` |

`logHookError(sourceFile, err, context?)`:

- Appends one sanitized line to `HOOK_ERROR_LOG` (default
  `/tmp/claude-hook-errors.log`): newlines stripped, capped at 3800 bytes
  with a `...` suffix.
- Opens the file **once** per process via fd with
  `O_CREAT | O_APPEND | O_WRONLY` and mode `0o600`; a failed open caches a
  `-1` sentinel and every later call silently discards. A symlink at the log
  path is unlinked before opening (lstat guard).
- Auto-rotates: when the file exceeds 1MB it is truncated via the fd and a
  `--- log rotated ---` line is written first.
- Each line carries context: ISO timestamp, source basename, `pid=`,
  `branch=` (via a git subprocess, cached per process), `cwd=`, and — when a
  `{ tool, input }` context is passed — `tool=`, `file=`, `cmd=` (truncated
  to 200 chars), `skill=`, `agent=`.
- `ENFORCE_HOOK_DEBUG=1` redirects the line to stderr for interactive
  debugging; the file is never opened in that mode.
- Exports `{ logHookError, LOG_FILE }`.

## Usage

Fail-open dispatcher (advisory hooks — injection, telemetry, nudges):

```js
#!/usr/bin/env node
'use strict';
const { runHook } = require('../../factories/hookEntrypoint');

runHook(
  async (payload) => {
    const out = decide(payload); // your hook logic
    if (out) process.stdout.write(out);
    // no explicit exit needed — runHook exits 0 when the handler resolves
  },
  { file: __filename }
);
```

Fail-closed guard (enforcement hooks — a fault must block the tool call):

```js
runHook(handler, { onError: 'closed', file: __filename });
```

Standalone pieces, for hooks that need a custom protocol:

```js
const { readStdin, parsePayload, logHookError } = require('../../factories/hookEntrypoint');

const payload = parsePayload(await readStdin());
try {
  await main(payload);
} catch (err) {
  logHookError(__filename, err, { tool: payload.tool_name, input: payload.tool_input });
}
process.exit(0);
```

## Why this shape

Every hook script re-implements the same four steps by hand: an event-based
stdin reader with a TTY guard, a JSON parse that must not throw, a guard
around the handler, and a terminal `process.exit`. The copies drift in
exactly the places that matter most:

- one hook forgets the TTY guard and hangs when run interactively;
- one lets a parse error escape and turns malformed stdin into a hook
  failure;
- one logs a fail-open error to stderr, which the host runtime counts as a
  failure — the opposite of fail-open;
- one exits 2 with an empty stderr, which some host runtimes silently
  downgrade to fail-open.

`runHook` makes the open/closed policy a single declarative choice, and
`logHookError` gives the open policy a safe destination (fd-based, 0o600,
symlink-guarded, size-capped) instead of the tempting `console.error`.

## Not covered by this factory

- **Argument dispatch** (e.g. `node hook.js <Event>` validation and
  per-event routing) — that is hook business logic; do it inside the
  handler and `process.exit(0)` early for unknown events.
- **Payload normalization across host runtimes** (field aliasing, envelope
  emission) — see the `runtime` factory; compose it inside the handler.
- **Conditional fail-open/fail-closed policies** (e.g. fail closed only when
  a config store exists). `onError` is static; a hook with a dynamic policy
  should keep `onError: 'open'` semantics and call `process.exit(2)` itself
  from a handler-level catch, or wire the pieces by hand.
- **stdout protocol** (what to print for injections, denies, or envelopes) —
  the handler owns stdout entirely.
