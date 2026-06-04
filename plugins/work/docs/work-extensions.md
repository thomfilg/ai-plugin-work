# /work Extensions — Author Guide

A per-repo pluggable extension API for /work's semantic events. Repos drop
JavaScript files into `.claude/work-extensions/` to react to /work's
lifecycle events without modifying the core plugin.

> **Phase 1 surface.** This document covers what ships today: the five
> Phase 1 events plus `passthrough` and `injectContext`. Phase 2 adds
> `handled` / `block`; Phase 3 adds the rest of the event surface. The
> Phase boundary is enforced in code (see [Phase boundary](#phase-boundary)).

## Quick start

```js
// .claude/work-extensions/log-ticket.js
module.exports = {
  events: ['OnTicketResolved'],
  priority: 50,
  handler: async (payload, ctx) => {
    ctx.injectContext(`[log-ticket] resolved ticket: ${payload.ticketId}`);
    return ctx.passthrough();
  },
};
```

Drop the file under `.claude/work-extensions/` in your repo. /work
discovers and registers it on the next session. No build step, no
configuration file — the export shape is the contract.

## Event taxonomy (Phase 1)

Each event fires at a well-defined site inside /work. Handlers receive
the payload below plus a `ctx` object.

| Event | Fires when | Payload shape |
|---|---|---|
| `OnSessionStart` | /work session begins (first `work-next.js` call after marker resolution) | `{ticketId: string, tasksDir: string, repoRoot: string}` |
| `OnTicketResolved` | `steps/ticket.js` transitions to resolved | `{ticketId: string, resolution: object, tasksDir: string}` |
| `OnPreToolCall` | PreToolUse hook fires, after the existing hook body, gated on active marker | `{toolName: string, toolInput: object}` |
| `OnPostToolCall` | PostToolUse hook fires, before auto-advance logic, gated on active marker | `{toolName: string, toolInput: object, toolResult: object}` |
| `OnAgentResponseMatched` | Plugin-level regex match against agent response text | `{responseText: string, match: {pattern: string, substring: string}}` |

### `OnAgentResponseMatched` declaration

Handlers for this event declare a `match` pattern at registration time.
The dispatcher compiles it once via `safeRegex` (`plugins/synapsys/lib/matcher.js`),
re-uses the compiled regex on each dispatch, and only fires the handler
when the response text matches.

```js
module.exports = {
  events: ['OnAgentResponseMatched'],
  match: /flak(e|y)/i,
  handler: async (payload, ctx) => {
    ctx.injectContext('See: docs/flake-runbook.md');
    return ctx.passthrough();
  },
};
```

Invalid patterns are rejected at registration with a logged error.

## Handler interface

A handler receives `(payload, ctx)` and returns a sentinel from `ctx`.

### `ctx.passthrough()` — Phase 1

Explicit no-op sentinel. Continues the dispatch chain. Most handlers
return `passthrough` after performing side effects.

```js
handler: async (payload, ctx) => {
  ctx.injectContext('cortex memories: 3 matched');
  return ctx.passthrough();
}
```

### `ctx.injectContext(text)` — Phase 1

Queues text for prompt injection. Multiple calls within the same dispatch
accumulate in insertion order. The accumulated text is returned by
`dispatch(...)` so call sites can wire it into the next prompt.

```js
ctx.injectContext('a');
ctx.injectContext('b');
// ctx.getInjectedContext() === ['a', 'b']
```

### `ctx.handled({result})` — Phase 2 (stub)

Throws `PhaseNotReadyError` in Phase 1. When Phase 2 lands, returning
`handled` will short-circuit the chain and replace /work's default action.

### `ctx.block({reason})` — Phase 2 (stub)

Throws `PhaseNotReadyError` in Phase 1. When Phase 2 lands, returning
`block` will abort the current workflow step with a structured error.

### `ctx.callTool(name, args)` — Phase 3 (stub)

Throws `PhaseNotReadyError` in Phase 1. When Phase 3 lands, handlers
will be able to invoke MCP tools (e.g. cortex_recall, rulesync) from
within a handler.

## Registration shape

```js
module.exports = {
  events: string[],       // required — event names to subscribe to
  handler: Function,      // required — (payload, ctx) => Promise<sentinel>
  priority?: number,      // optional — default 50, higher runs first
  match?: string | RegExp // required for OnAgentResponseMatched only
};
```

### Priority & tiebreaker

Handlers run in **priority descending** order (default `50`). Equal-priority
handlers run in **lexical filename ascending** order. The first handler
that returns `handled` or `block` short-circuits the chain (Phase 2+);
`passthrough` continues to the next.

## Fire order (per workflow step)

```
SessionStart        →  OnSessionStart   (once per process)
  ↓
ticket step         →  OnTicketResolved (on resolve transition)
  ↓
PreToolUse hook     →  OnPreToolCall    (per tool dispatch)
  ↓
PostToolUse hook    →  OnPostToolCall   (per tool result)
                    →  OnAgentResponseMatched (when text matches)
  ↓
... continues per step
```

`OnSessionStart` is guaranteed to fire before any other event. Tool-call
events fire on every gated PreToolUse / PostToolUse for the active session.

## Phase boundary

The Phase 1 → 2 → 3 boundary is enforced in code, not only docs.
`ctx.handled`, `ctx.block`, and `ctx.callTool` are present on the ctx
object in Phase 1, but throw a typed `PhaseNotReadyError` when called.

```js
try {
  return ctx.handled({result: 'foo'});
} catch (err) {
  if (err.name === 'PhaseNotReadyError') {
    // Phase 2 not yet enabled — fall back to passthrough
    return ctx.passthrough();
  }
  throw err;
}
```

When Phase 2 ships, the stubs become real and existing handlers continue
to work without modification.

## Type guidance (JSDoc)

Author handlers with JSDoc for editor autocomplete:

```js
/**
 * @typedef {object} OnTicketResolvedPayload
 * @property {string} ticketId
 * @property {object} resolution
 * @property {string} tasksDir
 */

/**
 * @param {OnTicketResolvedPayload} payload
 * @param {import('../../scripts/workflows/work/lib/extensions/ctx').Ctx} ctx
 */
module.exports.handler = async (payload, ctx) => { ... };
```

The plugin's `ctx.js` and `event-bus.js` carry full JSDoc on every exported
function and method.

## Error isolation

- **Load errors** (bad export shape, syntax errors, throw at `require()`):
  logged via `createDebugLog(tasksDir).error(...)` AND emitted to stderr
  at `warn` level. The extension is skipped; /work continues.
- **Handler runtime errors**: caught in `event-bus.dispatch`, logged via
  the same dual sink, and treated as `passthrough`. Subsequent handlers
  in the priority chain still run.
- **A broken extension MUST NOT crash /work.** This is enforced by tests
  in `__tests__/error-isolation.test.js` and `__tests__/loader.test.js`.

## Latency budget

Per-event dispatch overhead target: **< 5ms p99** with ≤ 3 handlers per
event. The registry is a pure in-memory map; the comparator runs once at
registration; `OnAgentResponseMatched` regexes are compiled once. The
common case has zero I/O on the dispatch path.

## Security posture

- **Host-machine trust model.** Extensions run in the same Node process
  as /work with full FS / network access. Treat `.claude/work-extensions/`
  as trusted code; review before committing.
- **Path-traversal hardening.** The loader resolves each candidate file
  via `fs.realpathSync` and rejects any file whose realpath does not
  remain under the resolved `.claude/work-extensions/` directory.
  Symlink escapes are blocked before `require()`.
- **No remote execution.** Phase 1 has no mechanism to fetch or load
  extensions from the network. Local files only.

## Diagnostic command

```bash
node plugins/work/scripts/workflows/work/scripts/work-extensions-status.js
# → [{"file":"cortex-auto-recall.js","events":["OnTicketResolved"],"loaded":true}, ...]

# Add --pretty for indented output
node ... --pretty
```

Lists every discovered extension file, its declared events, whether it
loaded, and the error message if not.

## Reference extensions

Three reference extensions ship in-tree under
`plugins/work/references/work-extensions/`:

| File | Events | Purpose |
|---|---|---|
| `cortex-auto-recall.js` | `OnTicketResolved` | Calls cortex_recall, injects matching memories |
| `flaky-test-runbook.js` | `OnAgentResponseMatched` (match: `/flak(e|y)/i`) | Injects runbook when agent mentions test flakes |
| `rulesync-redirect.js` | `OnReadDenied` (Phase 3 stub) | Demonstrates Phase 3 boundary — registers but logs "Phase 3 not yet enabled" |

Copy any of these into your repo's `.claude/work-extensions/` as a
starting point.
