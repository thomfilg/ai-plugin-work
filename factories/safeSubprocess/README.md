# safeSubprocess

Synchronous subprocess wrappers (`safeSpawnSync`, `safeExecFileSync`) that
make timeouts non-optional and shell interpolation impossible. A synchronous
child-process call with no deadline can freeze the entire event loop of its
host; these wrappers guarantee every call site either runs under a positive
finite timeout (default 15000 ms) or carries an explicit, review-visible
justification for running without one.

## Decision matrix

| # | Condition | Behavior |
|---|---|---|
| 1 | `command` not a non-empty string | throw `TypeError` |
| 2 | `args` not an array of strings | throw `TypeError` |
| 3 | `opts` not a plain object | throw `TypeError` |
| 4 | `opts.timeout` absent | default `15000` ms applied |
| 5 | `opts.timeout` positive finite number | used as-is |
| 6 | `opts.timeout` null / 0 / negative / NaN / Infinity / non-number | throw `TypeError` — no value means "no timeout" |
| 7 | `opts.noTimeout` is a non-empty string | run with **no** timeout; the key is omitted from the final opts |
| 8 | `opts.noTimeout` present but not a non-empty string | throw `TypeError` |
| 9 | `opts.shell` (any value) | stripped; `shell: false` always enforced |
| 10 | any other option (`cwd`, `encoding`, `env`, `input`, `stdio`, ...) | passed through untouched |

Failure semantics mirror the native calls:

- `safeSpawnSync(command, args?, opts?)` returns the **raw** `spawnSync`
  result object. Runtime failures (nonzero exit, missing binary, timeout)
  never throw — they land in `status` / `signal` / `error`.
- `safeExecFileSync(command, args?, opts?)` returns `execFileSync`'s return
  value and throws on any failure.

## Usage

```js
const { safeSpawnSync, safeExecFileSync } = require('factories/safeSubprocess');

// Raw result — the caller keeps its own success predicate:
const r = safeSpawnSync('git', ['rev-parse', '--show-toplevel'], {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
});
const toplevel = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;

// Throw-on-failure semantics:
const head = safeExecFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

// Long-running by design — a justification is mandatory:
safeSpawnSync('node', ['build.js'], {
  noTimeout: 'build duration is input-dependent; supervised by the caller',
});
```

## Why this shape

Hand-written `spawnSync`/`execFileSync` call sites drift in two predictable
ways: the timeout gets dropped (nothing forces it), and `shell: true` sneaks
in during a refactor. Both are silent until an incident.

- **Timeouts are policy, not opts.** The default merges in automatically;
  every way of expressing "no timeout" through the `timeout` key throws.
  The single escape hatch, `noTimeout`, demands a justification string, so
  "this call can hang forever" becomes a grep-able, code-reviewable artifact
  at the call site instead of a hidden `0`.
- **Raw results, not convenience semantics.** `safeSpawnSync` returns the
  untouched result object, so existing callers migrate by swapping the
  function name and keeping their exact success predicate (e.g.
  `r.status === 0 && r.stdout.trim() ? trimmed : null`). Baking in trimming
  or fallbacks would change behavior during migration.
- **`shell: false` with no opt-out.** Arguments are always passed
  positionally; metacharacters stay literal.

## Not covered by this factory

- Asynchronous execution (`spawn`, `exec`, promises, streaming output,
  long-lived children) — these wrappers are synchronous by design.
- Trim-and-fallback convenience ("stdout or fallback, never throw") — pair
  `safeSpawnSync` with your own predicate, or use a dedicated helper.
- Retries, backoff, or output-size policing beyond what the native
  `maxBuffer` option provides (which passes through).
- Building shell command strings — the shell is always disabled; if a
  caller genuinely needs a shell, this is the wrong tool.
